const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { HttpError } = require('./errors');
const { SSEDecoder } = require('../public/js/core/sse');

// Browser requests can span 200 tool calls. Give those streams more replay room
// while keeping the aggregate retained payload budget at the old 16 * 8 MiB.
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 16;
const MAX_BYTES = 8 * 1024 * 1024;
const BROWSER_MAX_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = MAX_SESSIONS * MAX_BYTES;

// A generation owns its output. HTTP connections only subscribe to that output;
// reconnecting must never repeat a tool call or reserve another message credit.
class ChatStream extends EventEmitter {
    constructor(identity, fingerprint, cancel, options = {}) {
        super();
        this.identity = identity;
        this.fingerprint = fingerprint;
        this.cancel = cancel;
        this.maxBytes = options.maxBytes ?? MAX_BYTES;
        this.maxEvents = options.maxEvents ?? 100000;
        this.reserve = options.reserve;
        this.heartbeatMs = options.heartbeatMs ?? 15000;
        this.events = [];
        this.bytes = 0;
        this.parser = new SSEDecoder();
        this.clients = new Map();
        this.headersSent = true;
        this.writableEnded = false;
        this.destroyed = false;
        this.completedAt = 0;
        this.startedAt = Date.now();
        this.log('started');
    }
    log(event, fields = {}) {
        console.info(
            '[chat-stream]',
            JSON.stringify({ event, timestamp: new Date().toISOString(), ...this.identity,
                elapsedMs: Date.now() - this.startedAt, ...fields })
        );
    }
    set() {
        return this;
    }
    append(event, terminal = false) {
        const id = this.events.length + 1;
        const frame =
            'id: ' +
            id +
            '\n' +
            (event.event === 'message' ? '' : 'event: ' + event.event + '\n') +
            event.data
                .split('\n')
                .map((line) => 'data: ' + line + '\n')
                .join('') +
            '\n';
        const bytes = Buffer.byteLength(frame);
        if (!terminal) {
            if (this.bytes + bytes > this.maxBytes || this.events.length >= this.maxEvents)
                throw new HttpError(502, '本次回复过长，请缩小任务范围后重试');
            this.reserve?.(bytes);
        }
        this.events.push(frame);
        this.bytes += bytes;
        for (const client of this.clients.values()) client.pump();
    }
    write(chunk) {
        if (this.writableEnded) throw new HttpError(499, '生成已经结束');
        if (this.bytes + Buffer.byteLength(chunk) > this.maxBytes)
            throw new HttpError(502, '本次回复过长，请缩小任务范围后重试');
        for (const event of this.parser.feed(String(chunk))) this.append(event);
        return true;
    }
    end(chunk) {
        if (this.writableEnded) return;
        if (chunk) this.write(chunk);
        this.writableEnded = true;
        this.completedAt = Date.now();
        for (const client of this.clients.values()) client.pump();
        this.log('ended', { events: this.events.length, bytes: this.bytes });
        this.emit('finish');
    }
    fail(message) {
        if (this.writableEnded) return;
        // Leave room for one terminal error even after the replay limit is hit.
        this.append({ event: 'message', data: JSON.stringify({ error: { message } }) }, true);
        this.log('failed', { reason: message });
        this.end();
    }
    attach(res, after) {
        if (!Number.isSafeInteger(after) || after < 0 || after > this.events.length)
            throw new HttpError(416, '回复续传位置无效');
        // Only keep a small number of readers; stale mobile sockets can linger.
        if (this.clients.size >= 2) this.clients.keys().next().value.end();
        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        const client = { index: after, blocked: false };
        const close = () => {
            if (!this.clients.delete(res)) return;
            clearInterval(timer);
            res.off('drain', drain);
            this.log('reader_closed', { completed: this.writableEnded, sentThrough: client.index });
        };
        client.pump = () => {
            if (res.destroyed || res.writableEnded) return close();
            while (!client.blocked && client.index < this.events.length)
                client.blocked = !res.write(this.events[client.index++]);
            if (this.writableEnded && client.index === this.events.length) res.end();
        };
        const drain = () => {
            client.blocked = false;
            client.pump();
        };
        const timer = setInterval(() => {
            if (res.destroyed || res.writableEnded) return close();
            if (!client.blocked) client.blocked = !res.write(': heartbeat\n\n');
        }, this.heartbeatMs);
        timer.unref();
        this.clients.set(res, client);
        res.once('close', close);
        res.on('drain', drain);
        client.blocked = !res.write(': connected\n\n');
        this.log('reader_attached', { after });
        client.pump();
    }
}

class ChatStreams {
    constructor(options = {}) {
        this.options = options;
        this.sessions = new Map();
        this.cancelled = new Map();
        this.retentionMs = options.retentionMs ?? RETENTION_MS;
        this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
        this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
        this.timer = setInterval(() => this.prune(), 30000);
        this.timer.unref();
    }
    key(userId, generationId) {
        return userId + ':' + generationId;
    }
    fingerprint(body) {
        return createHash('sha256')
            .update(
                JSON.stringify({
                    messages: body.messages,
                    reasoningEffort: body.reasoningEffort ?? 'default',
                    browserContext: body.browserContext ?? null
                })
            )
            .digest('hex');
    }
    prune() {
        const before = Date.now() - this.retentionMs;
        for (const [key, session] of this.sessions)
            if (session.completedAt && !session.clients.size && session.completedAt < before) this.sessions.delete(key);
        for (const [key, at] of this.cancelled) if (at < before) this.cancelled.delete(key);
    }
    get(userId, generationId, body) {
        this.prune();
        const key = this.key(userId, generationId);
        const session = this.sessions.get(key);
        if (session && session.fingerprint !== this.fingerprint(body))
            throw new HttpError(409, '任务编号已用于另一条请求');
        if (!session && this.cancelled.has(key)) throw new HttpError(409, '这条生成已经停止');
        return session;
    }
    lookup(userId, generationId) {
        this.prune();
        return this.sessions.get(this.key(userId, generationId));
    }
    tasks(userId) {
        this.prune();
        return [...this.sessions.values()].filter(session => session.identity.userId === userId)
            .map(session => ({ generationId: session.identity.generationId,
                ...session.browserContext, startedAt: session.startedAt,
                completedAt: session.completedAt || null,
                state: session.writableEnded ? 'completed' : 'running' }));
    }
    reserve(bytes, current) {
        let retained = 0;
        for (const session of this.sessions.values()) retained += session.bytes;
        if (retained + bytes <= this.maxTotalBytes) return;
        const finished = [...this.sessions]
            .filter(([, s]) => s !== current && s.completedAt && !s.clients.size)
            .sort((a, b) => a[1].completedAt - b[1].completedAt);
        for (const [key, session] of finished) {
            this.sessions.delete(key);
            retained -= session.bytes;
            if (retained + bytes <= this.maxTotalBytes) return;
        }
        // Never evict a running task or a replay still being read to make room.
        throw new HttpError(503, '生成结果缓存已满，本次生成已停止；请保留已有结果，待其他任务结束后继续。');
    }
    create(userId, generationId, body, cancel) {
        this.prune();
        if (this.sessions.size >= this.maxSessions) {
            const finished = [...this.sessions]
                .filter(([, s]) => s.completedAt && !s.clients.size)
                .sort((a, b) => a[1].completedAt - b[1].completedAt);
            if (!finished.length) throw new HttpError(429, '生成任务过多，请稍后再试');
            this.sessions.delete(finished[0][0]);
        }
        const session = new ChatStream(
            { userId, generationId },
            this.fingerprint(body),
            cancel,
            {
                ...this.options,
                maxBytes: this.options.maxBytes ?? (body.browserContext ? BROWSER_MAX_BYTES : MAX_BYTES),
                maxEvents: this.options.maxEvents ?? (body.browserContext ? 400000 : 100000),
                reserve: bytes => this.reserve(bytes, session)
            }
        );
        // Only identifiers are exposed by discovery; never return prompts or output.
        session.browserContext = body.browserContext ? {
            conversationId: body.browserContext.conversationId,
            messageId: body.browserContext.messageId
        } : {};
        this.sessions.set(this.key(userId, generationId), session);
        return session;
    }
    stop(userId, generationId) {
        this.prune();
        const key = this.key(userId, generationId);
        const session = this.sessions.get(key);
        if (session && !session.writableEnded) {
            session.log('cancel_requested');
            session.cancel();
        }
        // Stop may reach the server before the initial generation POST.
        if (!session) {
            if (this.cancelled.size >= 128) this.cancelled.delete(this.cancelled.keys().next().value);
            this.cancelled.set(key, Date.now());
        }
    }
    close() {
        clearInterval(this.timer);
    }
}
module.exports = { ChatStreams, ChatStream };
