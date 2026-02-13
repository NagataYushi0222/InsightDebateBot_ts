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
    flushAudio(): Map<string, string> {
        const flushedFiles = new Map<string, string>();

        for (const [userId, stream] of this.writeStreams.entries()) {
            // ストリームを閉じる
            stream.end();

            const filePath = this.activeFilePaths.get(userId);
            if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                flushedFiles.set(userId, filePath);
            }
        }

        // マップをクリア（次回の write で新規作成させる）
        this.writeStreams.clear();
        this.activeFilePaths.clear();

        return flushedFiles;
    }

    /**
     * データが存在するか（書き込み中のストリームがあるか）
     */
    hasData(): boolean {
        return this.writeStreams.size > 0;
    }
}
