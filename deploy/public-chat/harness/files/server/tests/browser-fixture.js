const http = require('node:http');
const { once } = require('node:events');
const Protocol = require('../../public/js/core/browser-protocol');
const { fixture } = require('./fixture');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=';
async function browserFixture(overrides = {}) {
    const state = {
        calls: [],
        connected: false,
        begins: 0,
        finishes: 0,
        connections: 0,
        contexts: 0,
        streams: new Set(),
        offline: false
    };
    state.emit = (event, data) => {
        for (const stream of state.streams)
            stream.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    };
    const token = 'private-test-browser-session';
    const server = http.createServer(async (req, res) => {
        const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        if (req.headers.authorization !== 'Bearer test-browser-bridge-key')
            return send(401, { error: 'wrong key' });
        const status = () => ({ sharing: state.connected, extension_connected: !state.offline });
        if (req.url === '/tools' && req.method === 'GET')
            return send(
                200,
                Object.keys(Protocol.labels).map((name) => ({
                    tool: name,
                    definition: {
                        type: 'function',
                        function: {
                            name,
                            description: Protocol.labels[name],
                            parameters: { type: 'object', properties: {} }
                        }
                    }
                }))
            );
        if (req.url === '/browser/status') return send(200, status());
        if (req.url === '/browser/connect') {
            if (state.offline) return send(503, { code: 'EXTENSION_NOT_CONNECTED' });
            if (state.connected && req.headers['x-strata-browser-session'] !== token)
                return send(403, { code: 'SHARING_REQUIRED' });
            if (!state.connected) state.begins++;
            state.connected = true;
            return send(200, { browser_session: token, status: status() });
        }
        if (!state.connected || req.headers['x-strata-browser-session'] !== token)
            return send(403, { code: 'SHARING_REQUIRED' });
        if (req.url === '/browser/context') {
            state.contexts++;
            return send(200, {
                title: '测试页面',
                text: '页面数据 42，<script>不可信网页内容</script>',
                image: { mime: 'image/png', data: png },
                ...state.contextObservation
            });
        }
        if (req.url === '/browser/events') {
            state.connections++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('event: state\ndata: ' + JSON.stringify(status()) + '\n\n');
            if (!state.withholdFrames)
                res.write(
                    'event: frame\ndata: ' +
                        JSON.stringify({ mime: 'image/png', data: png, timestamp: Date.now() }) +
                        '\n\n'
                );
            state.streams.add(res);
            res.on('close', () => state.streams.delete(res));
            return;
        }
        if (req.url === '/browser/finish') {
            state.finishes++;
            state.connected = false;
            for (const stream of state.streams) stream.end('event: state\ndata: {"sharing":false}\n\n');
            return send(200, { sharing: false });
        }
        if (req.url === '/tools') {
            req.setEncoding('utf8');
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw);
            state.calls.push(body);
            await state.beforeResult?.();
            if (state.toolError) return send(502, state.toolError);
            return send(200, {
                browser_observation: {
                    title: '测试页面',
                    text: '42',
                    elements: [{ ref: 'e1', role: 'textbox' }],
                    observation_id: state.calls.length,
                    ...(state.screenshotFailure ? { screenshot_error: 'SCREENSHOT_UNAVAILABLE' } : {}),
                    ...(!state.legacy && !state.screenshotFailure && body.observation?.screenshot
                        ? { image: { mime: 'image/png', data: png } }
                        : {}),
                    ...state.makeObservation?.(body, state.calls.length)
                }
            });
        }
        send(404, {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const f = await fixture({
        DEFAULT_FREE_MESSAGES: '100',
        REQUEST_TIMEOUT_MS: '5000',
        BROWSER_BRIDGE_URL: 'http://127.0.0.1:' + server.address().port,
        BROWSER_BRIDGE_KEY: 'test-browser-bridge-key',
        BROWSER_ALLOWED_USER_IDS: '1,2',
        ...overrides
    });
    return {
        ...f,
        bridge: state,
        async close() {
            await f.close();
            for (const stream of state.streams) stream.end();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    };
}
function complete(
    res,
    {
        content = '',
        reasoning = '',
        tool,
        args = {},
        id = 'call-' + Math.random().toString(36).slice(2),
        malformed,
        timings
    } = {}
) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
    if (reasoning) event({ choices: [{ delta: { reasoning_content: reasoning } }] });
    if (tool && content) event({ choices: [{ delta: { content } }] });
    if (tool) {
        const text = malformed || JSON.stringify(args),
            middle = Math.floor(text.length / 2);
        event({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id,
                                type: 'function',
                                function: { name: tool, arguments: text.slice(0, middle) }
                            }
                        ]
                    }
                }
            ]
        });
        event({
            choices: [
                {
                    delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(middle) } }] },
                    finish_reason: 'tool_calls'
                }
            ]
        });
    } else event({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
    if (timings) event({ timings });
    res.end('data: [DONE]\n\n');
    return true;
}
module.exports = { browserFixture, complete };
