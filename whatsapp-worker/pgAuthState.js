// Baileys auth state persisted in Postgres (Neon) instead of the local disk, so
// the linked WhatsApp session survives restarts on hosts with NO persistent disk
// (e.g. Render's free tier, whose filesystem is wiped on every restart/redeploy).
//
// One small table, keyed by session id:
//   wa_auth(session_id, data_key, value jsonb)   — 'creds' + one row per signal key.
// BufferJSON handles the Buffer/Uint8Array fields Baileys stores. Treat this table
// as account access — the same as the local auth/ dir it replaces.

import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

async function ensureTable(sql) {
    await sql`CREATE TABLE IF NOT EXISTS wa_auth (
        session_id text NOT NULL,
        data_key text NOT NULL,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, data_key)
    )`;
}

export async function usePostgresAuthState(sql, sessionId = 'default') {
    await ensureTable(sql);

    const readData = async (key) => {
        const [row] = await sql`SELECT value FROM wa_auth WHERE session_id = ${sessionId} AND data_key = ${key}`;
        if (!row) return null;
        // Re-run through BufferJSON.reviver so Buffers deserialize correctly.
        return JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
    };
    const writeData = async (key, value) => {
        const data = JSON.stringify(value, BufferJSON.replacer);
        await sql`INSERT INTO wa_auth (session_id, data_key, value, updated_at)
            VALUES (${sessionId}, ${key}, ${data}::jsonb, now())
            ON CONFLICT (session_id, data_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    };
    const removeData = async (key) => {
        await sql`DELETE FROM wa_auth WHERE session_id = ${sessionId} AND data_key = ${key}`;
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        result[id] = value;
                    }));
                    return result;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const type of Object.keys(data)) {
                        for (const id of Object.keys(data[type])) {
                            const value = data[type][id];
                            const key = `${type}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData('creds', creds),
        // Wipe the session (call on a "logged out" close so a fresh QR is issued).
        clearAuth: () => sql`DELETE FROM wa_auth WHERE session_id = ${sessionId}`,
    };
}
