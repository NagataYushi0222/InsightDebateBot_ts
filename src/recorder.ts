import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from './config';
import { ensureTempDir } from './audioProcessor';

/**
 * ユーザーごとのPCMバッファを管理するレコーダー
 * discord.js の AudioReceiveStream からの Opus パケットを
 * prism-media で PCM にデコードし蓄積する
 */
export class UserAudioRecorder {
    private userBuffers: Map<string, Buffer[]> = new Map();
    private timestamp: number;

    constructor() {
        this.timestamp = Math.floor(Date.now() / 1000);
        ensureTempDir();
    }

    /**
     * ユーザーのPCMデータを追加
     */
    write(userId: string, pcmData: Buffer): void {
        if (!this.userBuffers.has(userId)) {
            this.userBuffers.set(userId, []);
        }
        this.userBuffers.get(userId)!.push(pcmData);
    }

    /**
     * 蓄積された音声をディスクに保存し、バッファをクリア
     * @returns ユーザーID → ファイルパスのマップ
     */
    flushAudio(): Map<string, string> {
        const savedFiles = new Map<string, string>();
        const now = Math.floor(Date.now() / 1000);

        for (const [userId, chunks] of this.userBuffers.entries()) {
            if (chunks.length === 0) continue;

            const combined = Buffer.concat(chunks);
            if (combined.length === 0) continue;

            const filename = path.join(
                TEMP_AUDIO_DIR,
                `${this.timestamp}_${userId}_${now}.pcm`
            );

            try {
                fs.writeFileSync(filename, combined);
                savedFiles.set(userId, filename);
            } catch (e) {
                console.error(`Error saving audio for user ${userId}:`, e);
            }
        }

        // バッファクリア
        this.userBuffers.clear();

        return savedFiles;
    }

    /**
     * 特定のユーザーにデータがあるか
     */
    hasData(): boolean {
        for (const chunks of this.userBuffers.values()) {
            if (chunks.length > 0) return true;
        }
        return false;
    }
}
