const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('../server');
const { loadConfig } = require('../config');
const { Store } = require('../db');
async function fixture(overrides = {}, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ivyun-test-'));
    const state = { calls: [], disconnected: 0, content: '测试回复', delay: 0 };
    const upstream = http.createServer(async (req, res) => {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify(
                    req.url === '/props'
                        ? {
                              model_alias: 'test-model',
                              default_generation_settings: { n_ctx: 262144 },
                              chat_template: '{{ enable_thinking }}',
                              chat_template_caps: { supports_preserve_reasoning: true },
                              modalities: { vision: !!state.vision }
                          }
                        : { data: [{ id: 'test-model', meta: { n_ctx: 262144 } }] }
                )
            );
            return;
        }
        req.setEncoding('utf8');
        let bytes = '';
        for await (const chunk of req) bytes += chunk;
        const body = JSON.parse(bytes);
        state.calls.push({ body, authorization: req.headers.authorization });
        if (state.onCompletion && (await state.onCompletion(body, res))) return;
        const prompt = body.messages.at(-1).content;
        let timer;
        res.on('close', () => {
            clearInterval(timer);
            if (!res.writableEnded) state.disconnected++;
        });
        if (prompt === 'upstream-error') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid secret' } }));
            return;
        }
        if (prompt === 'wrong-type') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('login page');
            return;
        }
        if (prompt === 'timeout') {
            timer = setInterval(() => {}, 1000);
            return;
        }
        const delay = !body.stream && state.repairDelay !== undefined ? state.repairDelay : state.delay;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (res.destroyed) return;
        if (!body.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const content = state.repairResponses?.length
                ? state.repairResponses.shift()
                : (state.repairContent ?? state.content);
            res.end(JSON.stringify({ choices: [{ message: { content } }] }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (prompt === 'empty') {
            res.end('data: [DONE]\n\n');
            return;
        }
        const event = (content) =>
            'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n';
        if (prompt === 'stream-fixture' && state.chunks) {
            for (const chunk of state.chunks) {
                if (res.destroyed) return;
                res.write(event(chunk));
                await new Promise((resolve) => setTimeout(resolve, state.chunkInterval || 150));
            }
            await new Promise((resolve) => setTimeout(resolve, state.endDelay || 0));
            if (!res.destroyed) res.end('data: [DONE]\n\n');
            return;
        }
        if (prompt === 'slow') {
            res.write(event('第一段 **Markdown**'));
            timer = setInterval(() => res.write(event('继续')), 40);
            return;
        }
        if (prompt === 'broken') {
            res.end(event('部分内容'));
            return;
        }
        const metrics = state.statistics ? 'data: ' + JSON.stringify(state.statistics) + '\r\n\r\n' : '';
        const payload = event(state.content) + metrics + 'data: [DONE]\r\n\r\n';
        // Fragment protocol fields and UTF-8 transport independently.
        const data = Buffer.from(payload);
        res.write(data.subarray(0, 9));
        res.write(data.subarray(9, 35));
        res.end(data.subarray(35));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const config = Object.freeze({
        ...loadConfig({
            JWT_SECRET: 'test-secret-with-at-least-32-characters',
            ADMIN_PASSWORD: 'test-admin-password',
            DEFAULT_API_URL: 'http://127.0.0.1:' + upstream.address().port + '/v1/chat/completions',
            DEFAULT_API_KEY: 'test-system-key',
            DEFAULT_MODEL: 'test-model',
            DB_PATH: path.join(directory, 'db.sqlite'),
            REQUEST_TIMEOUT_MS: '1000',
            ...overrides
        }),
        ...(options.publicPath ? { publicPath: options.publicPath } : {})
    });
    const store = new Store(config.dbPath);
    const { app } = createApp({ config, store });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    async function request(route, body, token, options = {}) {
        const response = await fetch(url + route, {
            method: body ? 'POST' : 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: 'Bearer ' + token } : {})
            },
            body: body ? JSON.stringify(body) : undefined,
            ...options
        });
        return response;
    }
    async function register(name = 'user' + Math.random().toString(36).slice(2, 8), inviteCode) {
        const res = await request('/api/auth/register', {
            username: name,
            password: 'test-password',
            inviteCode
        });
        return res.json();
    }
    async function close() {
        server.closeAllConnections();
        upstream.closeAllConnections();
        await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
        store.close();
        const resolved = fs.realpathSync(directory);
        if (
            path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
            !path.basename(resolved).startsWith('ivyun-test-')
        )
            throw new Error('Unsafe test cleanup path');
        fs.rmSync(resolved, { recursive: true, force: true });
    }
    return { url, store, config, state, request, register, close, directory };
}
module.exports = { fixture };
