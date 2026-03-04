import { Database } from 'bun:sqlite';
import path from 'path';

const DB_PATH = path.resolve('bot_settings.db');

let db: Database;

function getConnection(): Database {
    if (!db) {
        db = new Database(DB_PATH);
        db.run('PRAGMA journal_mode = WAL');
    }
    return db;
}

import { DEFAULT_MODEL } from './config';

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
}

export function getGuildSettings(guildId: string): GuildSettings {
    const conn = getConnection();
    const row = conn.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as GuildSettings | undefined;
    if (row) {
        // DBマイグレーションせずにここに来た場合 model_name がない可能性があるので補完
        if (!row.model_name) row.model_name = DEFAULT_MODEL;
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
    const settings = getGuildSettings(guildId);
    (settings as any)[key] = value;

    const conn = getConnection();
    conn.prepare(`
    INSERT OR REPLACE INTO guild_settings (guild_id, api_key, analysis_mode, recording_interval, model_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, settings.api_key, settings.analysis_mode, settings.recording_interval, settings.model_name);
}
