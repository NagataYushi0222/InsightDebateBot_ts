import { Database } from 'bun:sqlite';
import path from 'path';

const DB_PATH = path.resolve('bot_settings.db');

let db: Database;

function getConnection(): Database {
    if (!db) {
        db = new Database(DB_PATH);
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA busy_timeout = 5000');
        db.run('PRAGMA synchronous = NORMAL');
    }
    return db;
}

import {
    DEFAULT_MODEL,
    DEPRECATED_MODEL_REPLACEMENTS,
    resolveGeminiModel,
} from './config';

export interface GuildSettings {
    guild_id: string;
    api_key: string | null;
    analysis_mode: string;
    recording_interval: number;
    model_name: string;
}

export function initDb(): void {
    const conn = getConnection();
    conn.run(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      api_key TEXT,
      analysis_mode TEXT DEFAULT 'debate',
      recording_interval INTEGER DEFAULT 300,
      model_name TEXT DEFAULT '${DEFAULT_MODEL}'
    )
  `);

    const columns = conn.prepare('PRAGMA table_info(guild_settings)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'model_name')) {
        conn.run(`ALTER TABLE guild_settings ADD COLUMN model_name TEXT DEFAULT '${DEFAULT_MODEL}'`);
    }

    conn.prepare(`
    UPDATE guild_settings
    SET model_name = ?
    WHERE model_name IS NULL OR TRIM(model_name) = ''
  `).run(DEFAULT_MODEL);

    for (const [deprecatedModel, replacementModel] of Object.entries(DEPRECATED_MODEL_REPLACEMENTS)) {
        conn.prepare(`
      UPDATE guild_settings
      SET model_name = ?
      WHERE model_name = ?
    `).run(replacementModel, deprecatedModel);
    }

    conn.run(`
    CREATE TABLE IF NOT EXISTS user_keys (
      user_id TEXT PRIMARY KEY,
      api_key TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function getGuildSettings(guildId: string): GuildSettings {
    const conn = getConnection();
    const row = conn.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as GuildSettings | undefined;
    if (row) {
        const resolvedModelName = resolveGeminiModel(row.model_name);
        if (row.model_name !== resolvedModelName) {
            row.model_name = resolvedModelName;
            conn.prepare('UPDATE guild_settings SET model_name = ? WHERE guild_id = ?').run(resolvedModelName, guildId);
        }
        return row;
    }
    return {
        guild_id: guildId,
        api_key: null,
        analysis_mode: 'debate',
        recording_interval: 300,
        model_name: DEFAULT_MODEL,
    };
}

export function updateGuildSetting(guildId: string, key: keyof GuildSettings, value: string | number | null): void {
    const conn = getConnection();
    const allowedKeys: Array<keyof GuildSettings> = [
        'api_key',
        'analysis_mode',
        'recording_interval',
        'model_name',
    ];
    if (!allowedKeys.includes(key)) {
        throw new Error(`Unsupported guild setting key: ${key}`);
    }

    const normalizedValue = key === 'model_name' && typeof value === 'string'
        ? resolveGeminiModel(value)
        : value;

    conn.prepare(`
    INSERT INTO guild_settings (guild_id, ${key})
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET ${key} = excluded.${key}
  `).run(guildId, normalizedValue);
}

export function getUserKey(userId: string): string | null {
    const conn = getConnection();
    const row = conn.prepare('SELECT api_key FROM user_keys WHERE user_id = ?').get(userId) as { api_key: string } | undefined;
    return row ? row.api_key : null;
}

export function setUserKey(userId: string, apiKey: string): void {
    const conn = getConnection();
    conn.prepare(`
    INSERT OR REPLACE INTO user_keys (user_id, api_key, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(userId, apiKey);
}
