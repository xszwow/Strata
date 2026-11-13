const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const INVITE_CODE_TYPES = Object.freeze({
    20: { quota: 20, name: '20次体验卡' },
    50: { quota: 50, name: '50次卡' }
});
class Store {
    constructor(filename, legacyPath) {
        if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.sql = new DatabaseSync(filename);
        this.sql.exec(`
            PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
                api_key TEXT NOT NULL DEFAULT '', free_messages INTEGER NOT NULL CHECK(free_messages >= 0),
                token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS invite_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
                quota INTEGER NOT NULL CHECK(quota >= 0), used INTEGER NOT NULL DEFAULT 0, used_by TEXT,
                used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS quota_reservations (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                state TEXT NOT NULL CHECK(state IN ('reserved','committed','refunded')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS browser_receipts (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                conversation_id TEXT NOT NULL, generation_id TEXT NOT NULL, call_id TEXT NOT NULL,
                record TEXT NOT NULL, touched INTEGER NOT NULL,
                PRIMARY KEY(user_id,conversation_id,generation_id,call_id));
            CREATE INDEX IF NOT EXISTS browser_receipts_expiry ON browser_receipts(touched);
            CREATE TABLE IF NOT EXISTS task_checkpoints (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                conversation_id TEXT NOT NULL, generation_id TEXT NOT NULL, items TEXT NOT NULL, touched INTEGER NOT NULL,
                PRIMARY KEY(user_id,conversation_id,generation_id));
            CREATE INDEX IF NOT EXISTS task_checkpoints_expiry ON task_checkpoints(touched);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        try {
            if (legacyPath && fs.existsSync(legacyPath)) this.importLegacy(legacyPath);
        } catch (error) {
            this.sql.close();
            throw error;
        }
    }
    transaction(fn) {
        this.sql.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.sql.exec('COMMIT');
            return value;
        } catch (error) {
            this.sql.exec('ROLLBACK');
            throw error;
        }
    }
    importLegacy(filename) {
        if (this.sql.prepare("SELECT value FROM metadata WHERE key='legacy_import'").get()) return;
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!Array.isArray(data.users)) throw new Error('旧数据库格式无效');
        this.transaction(() => {
            if (this.sql.prepare('SELECT COUNT(*) AS n FROM users').get().n)
                throw new Error('数据库非空，拒绝覆盖导入');
            for (const u of data.users)
                this.sql
                    .prepare(
                        'INSERT INTO users(id,username,password,api_key,free_messages,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
                    )
                    .run(
                        u.id,
                        u.username,
                        u.password,
                        u.api_key || '',
                        Math.max(0, u.free_messages ?? 0),
                        u.created_at || new Date().toISOString(),
                        u.updated_at || new Date().toISOString()
                    );
            for (const c of data.inviteCodes || [])
                this.sql
                    .prepare(
                        'INSERT INTO invite_codes(id,code,type,quota,used,used_by,used_at,created_at) VALUES(?,?,?,?,?,?,?,?)'
                    )
                    .run(
                        c.id,
                        c.code,
                        c.type,
                        c.quota,
                        c.used ? 1 : 0,
                        c.usedBy || null,
                        c.usedAt || null,
                        c.createdAt || new Date().toISOString()
                    );
            this.sql.prepare("INSERT INTO metadata VALUES('legacy_import',?)").run(new Date().toISOString());
        });
    }
    getUser(id) {
        return this.sql.prepare('SELECT * FROM users WHERE id=?').get(id);
    }
    findUser(name) {
        return this.sql.prepare('SELECT * FROM users WHERE username=?').get(name);
    }
    createUser(username, password, inviteCode, defaultQuota) {
        return this.transaction(() => {
            if (this.findUser(username)) throw new HttpError(409, '用户名已存在');
            let quota = defaultQuota;
            if (inviteCode) {
                const code = this.sql
                    .prepare('SELECT * FROM invite_codes WHERE code=? AND used=0')
                    .get(inviteCode);
                if (!code) throw new HttpError(409, '邀请码无效或已被使用');
                quota = code.quota;
                this.sql
                    .prepare(
                        'UPDATE invite_codes SET used=1,used_by=?,used_at=CURRENT_TIMESTAMP WHERE id=? AND used=0'
                    )
                    .run(username, code.id);
            }
            const result = this.sql
                .prepare('INSERT INTO users(username,password,free_messages) VALUES(?,?,?)')
                .run(username, password, quota);
            return this.getUser(Number(result.lastInsertRowid));
        });
    }
    reserveQuota(userId) {
        return this.transaction(() => {
            const changed = this.sql
                .prepare(
                    'UPDATE users SET free_messages=free_messages-1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND free_messages>0'
                )
                .run(userId);
            if (!changed.changes) return null;
            const id = randomUUID();
            this.sql
                .prepare("INSERT INTO quota_reservations(id,user_id,state) VALUES(?,?,'reserved')")
                .run(id, userId);
            return id;
        });
    }
    recoverReservations(before, active = new Set()) {
        return this.transaction(() => {
            const rows = this.sql
                .prepare(
                    "SELECT id,user_id FROM quota_reservations WHERE state='reserved' AND unixepoch(created_at)*1000 < ?"
                )
                .all(before)
                .filter((row) => !active.has(row.id));
            for (const row of rows) {
                this.sql.prepare("UPDATE quota_reservations SET state='refunded' WHERE id=?").run(row.id);
                this.sql
                    .prepare('UPDATE users SET free_messages=free_messages+1 WHERE id=?')
                    .run(row.user_id);
            }
            return rows.length;
        });
    }
    settleQuota(id, consumed) {
        if (!id) return;
        this.transaction(() => {
            const row = this.sql
                .prepare("SELECT * FROM quota_reservations WHERE id=? AND state='reserved'")
                .get(id);
            if (!row) return;
            this.sql
                .prepare('UPDATE quota_reservations SET state=? WHERE id=?')
                .run(consumed ? 'committed' : 'refunded', id);
            if (!consumed)
                this.sql
                    .prepare('UPDATE users SET free_messages=free_messages+1 WHERE id=?')
                    .run(row.user_id);
        });
    }
    setKey(id, key) {
        this.sql.prepare('UPDATE users SET api_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(key, id);
    }
    listUsers() {
        return this.sql.prepare('SELECT * FROM users ORDER BY id DESC').all();
    }
    deleteUser(id) {
        return this.sql.prepare('DELETE FROM users WHERE id=?').run(id).changes;
    }
    setQuota(id, quota) {
        return this.sql
            .prepare('UPDATE users SET free_messages=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(quota, id).changes;
    }
    setPassword(id, password) {
        return this.sql
            .prepare(
                'UPDATE users SET password=?,token_version=token_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?'
            )
            .run(password, id).changes;
    }
    createCodes(type, count) {
        const config = INVITE_CODE_TYPES[type];
        return this.transaction(() =>
            Array.from({ length: count }, () => {
                const code = randomBytes(10).toString('hex').toUpperCase();
                this.sql
                    .prepare('INSERT INTO invite_codes(code,type,quota) VALUES(?,?,?)')
                    .run(code, type, config.quota);
                return code;
            })
        );
    }
    listCodes() {
        return this.sql
            .prepare('SELECT * FROM invite_codes ORDER BY id DESC')
            .all()
            .map((c) => ({
                ...c,
                used: !!c.used,
                usedBy: c.used_by,
                usedAt: c.used_at,
                createdAt: c.created_at,
                typeName: INVITE_CODE_TYPES[c.type]?.name || c.type
            }));
    }
    deleteCode(id) {
        return this.sql.prepare('DELETE FROM invite_codes WHERE id=?').run(id).changes;
    }
    recordBrowserStep(owner, record, begin = false) {
        const args = [owner.userId, owner.conversationId, owner.generationId, record.id,
            JSON.stringify(record), Date.now()];
        if (begin) return this.sql.prepare(`INSERT OR IGNORE INTO browser_receipts
            (user_id,conversation_id,generation_id,call_id,record,touched) VALUES(?,?,?,?,?,?)`).run(...args).changes === 1;
        this.sql.prepare(`INSERT INTO browser_receipts VALUES(?,?,?,?,?,?)
            ON CONFLICT(user_id,conversation_id,generation_id,call_id) DO UPDATE SET
            record=excluded.record,touched=excluded.touched`).run(...args);
    }
    browserReceipts(userId, conversationId, generationId) {
        return this.sql.prepare(`SELECT record FROM browser_receipts
            WHERE user_id=? AND conversation_id=? AND generation_id=? ORDER BY rowid`)
            .all(userId, conversationId, generationId).map(row => JSON.parse(row.record));
    }
    pruneBrowserReceipts() {
        this.sql.prepare('DELETE FROM browser_receipts WHERE touched < ?').run(Date.now() - 86400000);
        this.sql.prepare('DELETE FROM task_checkpoints WHERE touched < ?').run(Date.now() - 86400000);
    }
    saveTasks(owner, generationId, items) {
        this.sql.prepare(`INSERT INTO task_checkpoints VALUES(?,?,?,?,?)
            ON CONFLICT(user_id,conversation_id,generation_id) DO UPDATE SET items=excluded.items,touched=excluded.touched`)
            .run(owner.userId, owner.conversationId, generationId, JSON.stringify(items), Date.now());
    }
    savedTasks(userId, conversationId, generationId) {
        const row = this.sql.prepare(`SELECT items FROM task_checkpoints
            WHERE user_id=? AND conversation_id=? AND generation_id=? AND touched>=?`)
            .get(userId, conversationId, generationId, Date.now() - 86400000);
        return row ? JSON.parse(row.items) : undefined;
    }
    close() {
        this.sql.close();
    }
}
module.exports = { Store, INVITE_CODE_TYPES };
