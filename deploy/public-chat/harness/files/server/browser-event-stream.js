'use strict';
// Copied from the existing LlamaUI/Strata bridge: browser/event-stream.cjs.
// Slow viewers need the newest frame, not an unbounded backlog or a forced disconnect.
function createEventStream(res) {
    let blocked = false,
        closed = false,
        ending = false;
    const pending = new Map();
    function flush() {
        if (closed || blocked) return;
        for (const type of ['state', 'notice', 'ping', 'frame']) {
            if (!pending.has(type)) continue;
            const data = pending.get(type);
            pending.delete(type);
            blocked = !res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
            if (blocked) break;
        }
        if (ending && !pending.has('state')) {
            closed = true;
            res.end();
        }
    }
    const drain = () => {
        blocked = false;
        flush();
    };
    res.on('drain', drain);
    const close = () => {
        closed = true;
        pending.clear();
        res.off('drain', drain);
    };
    res.once('close', close);
    return {
        send(type, data) {
            if (closed || ending || res.destroyed || res.writableEnded) return;
            if (type === 'state' && !data.sharing) {
                ending = true;
                pending.clear();
            }
            pending.set(type, data);
            flush();
        },
        close,
        end() {
            ending = true;
            flush();
        }
    };
}
module.exports = { createEventStream };
