const express = require('express');
const { HttpError, wrap } = require('../errors');
const { authentication } = require('../middleware/auth');
const { requestScope, fetchCompletion, proxyStream } = require('../upstream');
const { ModelInfo } = require('../model-info');
const { modelStatus, connectionFailure } = require('../model-lifecycle');
const LlamaComposer = require('../../public/js/core/composer-protocol');
const BrowserProtocol = require('../../public/js/core/browser-protocol');
const { browserReply } = require('../browser-agent');
const { ChatStreams } = require('../chat-streams');
const { validateTasks } = require('../task-list');

function validateMessages(body, config) {
    if (!Array.isArray(body?.messages) || !body.messages.length || body.messages.length > 200)
        throw new HttpError(400, '消息数量无效');
    let chars = 0;
    const messages = body.messages.map((m) => {
        if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')
            throw new HttpError(400, '消息格式无效');
        chars += m.content.length;
        return { role: m.role, content: m.content };
    });
    if (chars > config.maxInputChars) throw new HttpError(413, '对话或附件过长，请缩小文件或新建会话');
    return messages;
}
function chatRoutes(config, store, fetchImpl, browser) {
    const router = express.Router();
    const active = new Map();
    const reservations = new Set();
    const models = new ModelInfo(config, fetchImpl);
    const streams = new ChatStreams();
    router.get('/status', authentication(config, store), (req, res) => res.json(modelStatus(config)));
    router.get('/tasks', authentication(config, store), (req, res) =>
        res.json({ tasks: streams.tasks(req.user.id), maxConcurrent: config.maxConcurrent,
            browserMaxActions: config.browserMaxActions }));
    router.get('/stream', authentication(config, store), (req, res, next) => {
        try {
            if (!BrowserProtocol.validId(req.query.generationId) || !/^\d+$/.test(req.query.after ?? '0'))
                throw new HttpError(400, '回复续传参数无效');
            const session = streams.lookup(req.user.id, req.query.generationId);
            if (!session) {
                const taskList = BrowserProtocol.validId(req.query.conversationId)
                    ? store.savedTasks(req.user.id, req.query.conversationId, req.query.generationId) : undefined;
                throw new HttpError(410, '原任务已过期或服务已重启，无法续传，请检查已有结果后重新生成', { taskList });
            }
            session.attach(res, Number(req.query.after ?? 0));
        } catch (error) {
            next(error);
        }
    });
    router.post('/cancel', authentication(config, store), (req, res, next) => {
        if (!BrowserProtocol.validId(req.body?.generationId))
            return next(new HttpError(400, '生成任务标识无效'));
        streams.stop(req.user.id, req.body.generationId);
        const conversationId = req.body.conversationId;
        const receipts = BrowserProtocol.validId(conversationId)
            ? store.browserReceipts(req.user.id, conversationId, req.body.generationId) : [];
        const taskList = BrowserProtocol.validId(conversationId)
            ? store.savedTasks(req.user.id, conversationId, req.body.generationId) : undefined;
        res.json({ stopped: true, receipts, taskList });
    });
    router.get(
        '/model',
        authentication(config, store),
        wrap(async (req, res) => {
            const key =
                req.user.free_messages > 0 && config.apiKey
                    ? config.apiKey
                    : req.user.api_key || config.apiKey;
            res.json(await models.get(key));
        })
    );
    router.post(
        '/completions',
        authentication(config, store),
        wrap(async (req, httpResponse) => {
            const messages = validateMessages(req.body, config);
            const effort = req.body.reasoningEffort ?? 'default';
            if (!LlamaComposer.valid(effort)) throw new HttpError(400, '推理档位无效');
            const user = req.user;
            const generationId = req.body.generationId;
            const resumable = generationId !== undefined;
            if (config.requireResumableChat && req.body.stream !== false && !resumable) {
                console.info(
                    '[chat-stream]',
                    JSON.stringify({
                        event: 'outdated_client_rejected',
                        timestamp: new Date().toISOString(),
                        userId: user.id
                    })
                );
                throw new HttpError(
                    426,
                    '页面已更新，请刷新页面后再发送；旧页面不支持断线续传，本次尚未执行'
                );
            }
            if (resumable && (!BrowserProtocol.validId(generationId) || req.body.stream === false))
                throw new HttpError(400, '生成任务标识无效');
            const after = req.body.resumeAfter ?? 0;
            if (resumable && (!Number.isSafeInteger(after) || after < 0))
                throw new HttpError(400, '回复续传位置无效');
            const browserContext = req.body.browserContext;
            if (
                browserContext &&
                (!BrowserProtocol.validId(browserContext.conversationId) ||
                    !BrowserProtocol.validId(browserContext.messageId))
            )
                throw new HttpError(400, '浏览器对话标识无效');
            const previousRuns = browserContext?.previousRuns ?? [];
            const taskList = browserContext?.taskList === undefined ? undefined : validateTasks(browserContext.taskList);
            if (taskList && !resumable) throw new HttpError(400, '会话待办需要可恢复的生成任务');
            if (!Array.isArray(previousRuns) || previousRuns.length > 16 || previousRuns.some(id => !BrowserProtocol.validId(id)))
                throw new HttpError(400, '历史任务标识无效');
            if (resumable) {
                const previous = streams.get(user.id, generationId, req.body);
                if (previous) {
                    previous.attach(httpResponse, after);
                    return;
                }
                // A missing resume must never silently restart a browser task.
                if (req.body.resume || after)
                    throw new HttpError(410, '原任务已过期或服务已重启，无法续传，请检查已有结果后重新生成');
            }
            const withBrowser = !!browserContext && browser.allowed(user.id) && req.body.stream !== false;
            const running = browserContext && streams.tasks(user.id).find(task =>
                task.state === 'running' && task.conversationId === browserContext.conversationId);
            if (running) throw new HttpError(409, '这个对话的原任务仍在运行，请恢复原任务结果', {
                code: 'GENERATION_RUNNING', task: running
            });
            const identity = browserContext ? { conversationId: browserContext.conversationId,
                messageId: browserContext.messageId, userId: user.id } : null;
            const cancellation = new AbortController();
            const release = withBrowser ? browser.claim(identity, () => cancellation.abort()) : () => {};
            if ((active.get(user.id) || 0) >= config.maxConcurrent) {
                release();
                throw new HttpError(429, '同时生成的请求过多，请先查看正在运行的任务', {
                    code: 'GENERATION_CAPACITY', tasks: streams.tasks(user.id).filter(task => task.state === 'running')
                });
            }
            let session;
            try {
                if (resumable) {
                    session = streams.create(user.id, generationId, req.body, () => cancellation.abort());
                    session.attach(httpResponse, 0);
                }
            } catch (error) {
                release();
                throw error;
            }
            const res = session || httpResponse;
            active.set(user.id, (active.get(user.id) || 0) + 1);
            const scope = requestScope(
                req,
                res,
                withBrowser ? config.browserTimeoutMs : config.requestTimeoutMs,
                cancellation.signal,
                { detached: !!session }
            );
            let reservation = null;
            let consumed = false;
            try {
                store.recoverReservations(
                    Date.now() - Math.max(config.requestTimeoutMs, config.browserTimeoutMs) - 5000,
                    reservations
                );
                if (config.apiKey) reservation = store.reserveQuota(user.id);
                if (reservation) reservations.add(reservation);
                const apiKey = reservation ? config.apiKey : user.api_key;
                if (!apiKey)
                    throw new HttpError(
                        400,
                        config.apiKey
                            ? '免费额度已用完，请配置 API 密钥'
                            : '系统未配置模型密钥，请配置个人 API 密钥',
                        { needApiKey: true }
                    );
                const stream = req.body.stream !== false;
                const model = await models.get(apiKey);
                if (!model.reasoningLevels.includes(effort))
                    throw new HttpError(400, '当前模型不支持该推理档位');
                const reasoning = LlamaComposer.reasoningPayload(effort, model.reasoningMode);
                // The -1 sentinel is supported by llama/Strata. Other APIs use
                // their own default when no explicit output cap is configured.
                const output =
                    config.maxTokens > 0 || model.reasoningMode === 'llama'
                        ? { max_tokens: config.maxTokens }
                        : {};
                const statistics = stream
                    ? model.reasoningMode === 'llama'
                        ? { return_progress: true, timings_per_token: true, reasoning_format: 'auto' }
                        : { stream_options: { include_usage: true } }
                    : {};
                if (withBrowser || taskList) {
                    store.pruneBrowserReceipts();
                    const receipts = [];
                    let budget = 24000;
                    for (const id of [...new Set(previousRuns)].reverse()) {
                        if (budget <= 0) break;
                        const rows = store.browserReceipts(user.id, identity.conversationId, id);
                        const steps = [];
                        for (const row of rows.reverse()) {
                            if (row.state === 'not_dispatched') continue;
                            const { error, code, ...evidence } = row;
                            budget -= JSON.stringify(evidence).length + 1;
                            if (budget < 0) break;
                            steps.unshift(evidence);
                        }
                        if (steps.length) receipts.unshift({ generation: id, steps });
                    }
                    await browserReply({
                        config,
                        apiKey,
                        res,
                        signal: scope.signal,
                        fetchImpl,
                        bridge: withBrowser ? browser : null,
                        taskList,
                        saveTasks: items => store.saveTasks(identity, generationId, items),
                        previousReceipts: receipts,
                        recordStep: resumable ? (step, begin) => store.recordBrowserStep(
                            { ...identity, generationId }, step, begin) : undefined,
                        identity,
                        model,
                        onActivity: scope.touch,
                        payload: {
                            messages,
                            stream,
                            ...output,
                            ...reasoning,
                            ...statistics
                        },
                        onContent: () => {
                            if (!consumed) {
                                store.settleQuota(reservation, true);
                                consumed = true;
                            }
                        }
                    });
                    return;
                }
                const response = await fetchCompletion(
                    config,
                    apiKey,
                    { messages, stream, ...output, ...reasoning, ...statistics },
                    scope.signal,
                    fetchImpl
                );
                scope.touch();
                if (stream) {
                    res.set({
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache, no-transform',
                        'X-Accel-Buffering': 'no'
                    });
                    await proxyStream(
                        response,
                        res,
                        scope.signal,
                        () => {
                            if (!consumed) {
                                store.settleQuota(reservation, true);
                                consumed = true;
                            }
                        },
                        scope.touch
                    );
                    res.end();
                } else {
                    const data = await response.json();
                    if (
                        typeof data.choices?.[0]?.message?.content !== 'string' ||
                        !data.choices[0].message.content
                    )
                        throw new HttpError(502, '模型未返回有效内容');
                    consumed = true;
                    store.settleQuota(reservation, true);
                    res.json(data);
                }
            } catch (error) {
                const unavailable = connectionFailure(error, config);
                const failure = scope.timedOut
                    ? new HttpError(504, '模型响应超时，请重试')
                    : unavailable
                      ? new HttpError(503, unavailable)
                      : error;
                if (session) {
                    session.fail(
                        failure.status
                            ? failure.message
                            : failure.name === 'AbortError'
                              ? '回答已停止'
                              : '生成中断，请重试'
                    );
                    return;
                }
                if (res.destroyed) return;
                if (res.headersSent) {
                    res.write(
                        'data: ' +
                            JSON.stringify({
                                error: { message: failure.status ? failure.message : '生成中断，请重试' }
                            }) +
                            '\n\n'
                    );
                    res.end();
                } else {
                    res.removeHeader('Content-Type');
                    throw failure.name === 'AbortError' ? new HttpError(499, '请求已取消') : failure;
                }
            } finally {
                store.settleQuota(reservation, consumed);
                reservations.delete(reservation);
                scope.dispose();
                release();
                const count = (active.get(user.id) || 1) - 1;
                if (count) active.set(user.id, count);
                else active.delete(user.id);
            }
        })
    );
    return router;
}
module.exports = { chatRoutes, validateMessages };
