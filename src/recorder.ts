import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TEMP_AUDIO_DIR } from './config';
import { ensureTempDir } from './audioProcessor';
import { OggOpusMuxer } from './oggOpusMuxer';

/**
 * ユーザーごとの音声をディスクに直接書き込むレコーダー
 * メモリ使用量を抑えるため、バッファリングせずにストリームで書き込む
 */
export class UserAudioRecorder {
    private writeStreams: Map<string, fs.WriteStream> = new Map();
    private activeFilePaths: Map<string, string> = new Map();
    private muxers: Map<string, OggOpusMuxer> = new Map();

    constructor() {
        ensureTempDir();
    }

    /**
     * ユーザーのPCMデータをファイルに書き込み
     */
    writeOpus(userId: string, opusPacket: Buffer): void {
        // Discord 側の終端通知等を音声 packet として mux しない。
        if (opusPacket.length === 0) return;

        let stream = this.writeStreams.get(userId);

        if (!stream) {
            const filename = path.join(
                TEMP_AUDIO_DIR,
                `recording_${userId}_${Date.now()}_${crypto.randomUUID()}.ogg`
            );
            stream = fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 });
            this.writeStreams.set(userId, stream);
            this.activeFilePaths.set(userId, filename);
            const muxer = new OggOpusMuxer();
            this.muxers.set(userId, muxer);
            stream.write(Buffer.concat(muxer.headers()));

            // エラーハンドリング
            stream.on('error', (err) => {
                console.error(`Stream error for user ${userId}:`, err);
            });
        }

        const page = this.muxers.get(userId)!.packet(opusPacket);
        if (page.length > 0) stream.write(page);
    }

    /**
     * 現在書き込み中のファイルをクローズし、パスを返却する
     * 次回の書き込み書き込み時に新しいファイルが作成される
     */
    async flushAudio(): Promise<Map<string, string>> {
        const flushedFiles = new Map<string, string>();
        const closePromises: Promise<void>[] = [];

        for (const [userId, stream] of this.writeStreams.entries()) {
            const filePath = this.activeFilePaths.get(userId);

            closePromises.push(new Promise((resolve) => {
                stream.once('close', resolve);
                stream.once('finish', resolve);
                const eosPage = this.muxers.get(userId)?.end() ?? Buffer.alloc(0);
                if (eosPage.length > 0) stream.end(eosPage);
                else stream.end();
            }));

            if (filePath) {
                flushedFiles.set(userId, filePath);
            }
        }

        await Promise.all(closePromises);

        // マップをクリア（次回の write で新規作成させる）
        this.writeStreams.clear();
        this.activeFilePaths.clear();
        this.muxers.clear();

        const existingFiles = new Map<string, string>();
        for (const [userId, filePath] of flushedFiles.entries()) {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                existingFiles.set(userId, filePath);
            }
        }

        return existingFiles;
    }

    /**
     * データが存在するか（書き込み中のストリームがあるか）
     */
    hasData(): boolean {
        return this.writeStreams.size > 0;
    }
}
