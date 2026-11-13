const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HttpError } = require('./errors');
const Protocol = require('../public/js/core/browser-protocol');
const { safeBrowserCode, browserErrorMessage } = require('./browser-errors');
const { withWaitContract, navigationParameters } = require('./browser-parameters');

class BrowserBridge {
    constructor(config, fetchImpl = fetch) {
        this.config = config;
        this.fetch = fetchImpl;
        this.lease = null;
        this.connecting = false;
        this.runs = new Map();
        this.key = config.browserKey || '';
        if (config.browserUrl && config.browserKeyFile) {
            const saved = fs.readFileSync(config.browserKeyFile, 'utf8').trim();
            this.key = saved.startsWith('{') ? JSON.parse(saved).api_key : saved;
        }
        if (config.browserUrl && (typeof this.key !== 'string' || !this.key))
            throw new Error('浏览器桥接需要 BROWSER_BRIDGE_KEY 或 BROWSER_BRIDGE_KEY_FILE');
        this.enabled = !!config.browserUrl;
    }
    owns(identity, lease = this.lease) {
        return (
            !!lease && lease.userId === identity.userId && lease.conversationId === identity.conversationId
        );
    }
    allowed(userId) {
        return this.enabled && this.config.browserAllowedUsers.includes(String(userId));
    }
    claim(identity, cancel) {
        const key = identity.userId + ':' + identity.conversationId;
        if (this.runs.has(key)) throw new HttpError(409, '这个对话正在生成，请等待当前回复结束');
        const run = {
            messageId: identity.messageId,
            stopped: false,
            cancel: () => {
                run.stopped = true;
                cancel?.();
            }
        };
        this.runs.set(key, run);
        return () => this.runs.delete(key);
    }
    stopped(identity) {
        return !!this.runs.get(identity.userId + ':' + identity.conversationId)?.stopped;
    }
    async startWorker() {
        if (this.starting) return this.starting;
        this.starting = (async () => {
            const child = spawn(process.execPath, [this.config.browserStartScript], {
                cwd: path.dirname(this.config.browserStartScript),
                windowsHide: true,
                detached: true,
                stdio: 'ignore'
            });
            let failed = false;
            child.once('error', () => {
                failed = true;
            });
            child.unref();
            for (let attempt = 0; attempt < 40 && !failed; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                try {
                    const response = await this.fetch(new URL('/browser/health', this.config.browserUrl), {
                        headers: { Authorization: 'Bearer ' + this.key },
                        signal: AbortSignal.timeout(500),
                        redirect: 'error'
                    });
                    const health = await response.json();
                    if (response.ok && health.service === 'strata-chrome-browser') return;
                } catch {}
            }
            throw new HttpError(503, '浏览器桥接启动失败，请检查服务配置');
        })();
        try {
            await this.starting;
        } finally {
            this.starting = null;
        }
    }
    async request(route, { token, body, signal, stream = false, retried = false } = {}) {
        if (!this.enabled) throw new HttpError(503, '浏览器功能尚未配置');
        const timeout = stream ? signal : AbortSignal.timeout(35000);
        let response;
        try {
            response = await this.fetch(new URL(route, this.config.browserUrl), {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    Authorization: 'Bearer ' + this.key,
                    ...(token ? { 'X-Strata-Browser-Session': token } : {}),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal:
                    signal && timeout && signal !== timeout ? AbortSignal.any([signal, timeout]) : timeout,
                redirect: 'error'
            });
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (!retried && error.cause?.code === 'ECONNREFUSED' && this.config.browserStartScript) {
                await this.startWorker();
                return this.request(route, { token, body, signal, stream, retried: true });
            }
            const timedOut = error.name === 'TimeoutError';
            const failure = new HttpError(
                timedOut ? 504 : 503,
                timedOut ? '浏览器桥接响应超时，请重新读取页面' : '浏览器桥接未连接，请检查 Strata 浏览器服务'
            );
            failure.code = timedOut ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNAVAILABLE';
            throw failure;
        }
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            const code = safeBrowserCode(data?.code || data?.error?.code);
            const error = new HttpError(response.status, browserErrorMessage(code));
            error.code = code;
            throw error;
        }
        return stream ? response : response.json();
    }
    async definitions(signal) {
        const list = await this.request('/tools', { signal });
        if (!Array.isArray(list)) throw new HttpError(502, '浏览器工具列表无效');
        return list
            .filter(
                (tool) =>
                    Object.hasOwn(Protocol.labels, tool.tool) && tool.definition?.function?.name === tool.tool
            )
            .map((tool) => withWaitContract(tool.definition));
    }
    async status(identity, signal) {
        if (!this.allowed(identity.userId)) return { available: false, sharing: false };
        try {
            const lease = this.lease;
            const status = await this.request('/browser/status', { signal });
            if (!status.sharing && this.lease === lease) this.lease = null;
            const owned = status.sharing && this.owns(identity);
            return {
                available: true,
                extensionConnected: !!status.extension_connected,
                sharing: !!owned,
                busy: !!status.sharing && !owned,
                ...(owned ? { messageId: this.lease.messageId, callId: this.lease.callId } : {})
            };
        } catch {
            return { available: false, sharing: false };
        }
    }
    async connect(identity, signal) {
        if (this.connecting) throw new HttpError(409, '另一个浏览器任务正在连接');
        this.connecting = true;
        try {
            const run = this.runs.get(identity.userId + ':' + identity.conversationId);
            // Check the bridge first; its five-minute idle expiry can invalidate our local lease.
            const status = await this.request('/browser/status', { signal });
            // A reconnect is a new task, not evidence that previous actions failed.
            // Once this generation has used a session, never silently recreate it.
            if (
                run?.browserToken &&
                (!status.sharing || !this.owns(identity) || this.lease.token !== run.browserToken)
            ) {
                const error = new HttpError(409, browserErrorMessage('BROWSER_SESSION_LOST'));
                error.code = 'BROWSER_SESSION_LOST';
                throw error;
            }
            if (!status.sharing) this.lease = null;
            if (status.sharing && !this.owns(identity)) {
                const error = new HttpError(409, '另一个对话正在使用浏览器，本轮已停止争用，请返回原任务查看进度');
                error.code = 'BROWSER_IN_USE';
                throw error;
            }
            const data = await this.request('/browser/connect', {
                token: this.lease?.token,
                body: {}
            });
            this.lease = { ...identity, token: data.browser_session };
            if (run?.browserToken && run.browserToken !== this.lease.token) {
                const error = new HttpError(409, browserErrorMessage('BROWSER_SESSION_LOST'));
                error.code = 'BROWSER_SESSION_LOST';
                throw error;
            }
            if (run) run.browserToken = this.lease.token;
            if (signal.aborted) {
                if (signal.reason?.code !== 'CLIENT_DISCONNECTED' || this.stopped(identity))
                    await this.finish(identity, AbortSignal.timeout(5000)).catch(() => {});
                throw signal.reason;
            }
            return this.lease;
        } finally {
            this.connecting = false;
        }
    }
    async execute(identity, name, params, signal, onConnected, observation = { screenshot: true }) {
        if (!Object.hasOwn(Protocol.labels, name)) throw new HttpError(400, '不支持的浏览器工具');
        if (name === 'browser_finish') return this.finish(identity, signal);
        const lease = await this.connect(identity, signal);
        await onConnected?.();
        const prepared = navigationParameters(name, params);
        const observationResult = (
            await this.request('/tools', {
                token: lease.token,
                body: { tool: name, params: prepared.params, observation: {
                    screenshot: observation.screenshot === 'auto' ? 'auto' : observation.screenshot !== false,
                    detail: observation.detail === 'focused' ? 'focused' : 'full'
                } },
                signal
            })
        ).browser_observation;
        return prepared.adjustment
            ? { ...observationResult, parameter_adjustments: [prepared.adjustment] }
            : observationResult;
    }
    async context(identity, signal) {
        if (!this.owns(identity)) return null;
        const run = this.runs.get(identity.userId + ':' + identity.conversationId);
        if (run) run.browserToken ??= this.lease.token;
        try {
            return await this.request('/browser/context', { token: this.lease.token, signal });
        } catch (error) {
            if (error.code === 'SHARING_REQUIRED') this.lease = null;
            if (signal.aborted) throw signal.reason;
            return null;
        }
    }
    async finish(identity, signal) {
        if (!this.owns(identity)) return { closed: true };
        const lease = this.lease;
        try {
            await this.request('/browser/finish', { token: lease.token, body: {}, signal });
        } catch (error) {
            if (error.code !== 'SHARING_REQUIRED') throw error;
        }
        if (this.lease === lease) this.lease = null;
        const run = this.runs.get(identity.userId + ':' + identity.conversationId);
        if (run) run.browserToken = null;
        return { closed: true };
    }
    async stop(identity, signal) {
        const run = this.runs.get(identity.userId + ':' + identity.conversationId);
        const owned = this.owns(identity);
        if (!run && !owned) throw new HttpError(403, '这个对话没有活动中的浏览器任务');
        if (
            (run && run.messageId !== identity.messageId) ||
            (owned && this.lease.messageId !== identity.messageId)
        )
            throw new HttpError(409, '浏览器已在处理另一条消息');
        run?.cancel?.();
        return this.finish(identity, signal);
    }
}
module.exports = { BrowserBridge };
