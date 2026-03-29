import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from './config';
import { ensureTempDir } from './audioProcessor';

/**
 * ユーザーごとの音声をディスクに直接書き込むレコーダー
 * メモリ使用量を抑えるため、バッファリングせずにストリームで書き込む
 */
export class UserAudioRecorder {
    private writeStreams: Map<string, fs.WriteStream> = new Map();
    private activeFilePaths: Map<string, string> = new Map();

    constructor() {
        ensureTempDir();
    }

    /**
     * ユーザーのPCMデータをファイルに書き込み
     */
    write(userId: string, pcmData: Buffer): void {
        let stream = this.writeStreams.get(userId);

        if (!stream) {
            const filename = path.join(
                TEMP_AUDIO_DIR,
                `recording_${userId}_${Date.now()}.pcm`
            );
            stream = fs.createWriteStream(filename, { flags: 'a' });
            this.writeStreams.set(userId, stream);
            this.activeFilePaths.set(userId, filename);

            // エラーハンドリング
            stream.on('error', (err) => {
                console.error(`Stream error for user ${userId}:`, err);
            });
        }

        stream.write(pcmData);
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
                stream.end();
            }));

            if (filePath) {
                flushedFiles.set(userId, filePath);
            }
        }

        await Promise.all(closePromises);

        // マップをクリア（次回の write で新規作成させる）
        this.writeStreams.clear();
        this.activeFilePaths.clear();

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
