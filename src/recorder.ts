import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from './config';
import { OggOpusMuxer } from './oggOpusMuxer';

interface OpenRecording {
    userId: string;
    filePath: string;
    stream: fs.WriteStream;
    muxer: OggOpusMuxer;
}

/** ユーザー別のOpus packetを再エンコードせずOggへ書き出す。 */
export class UserAudioRecorder {
    private writeStreams = new Map<string, fs.WriteStream>();
    private activeFilePaths = new Map<string, string>();
    private muxers = new Map<string, OggOpusMuxer>();
    private readonly failedStreams = new WeakSet<fs.WriteStream>();

    constructor(private readonly outputDirectory: string = TEMP_AUDIO_DIR) {
        fs.mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 });
    }

    writeOpus(userId: string, opusPacket: Buffer): void {
        if (opusPacket.length === 0) return;

        let stream = this.writeStreams.get(userId);
        if (!stream) {
            const filename = path.join(
                this.outputDirectory,
                `recording_${userId}_${Date.now()}_${crypto.randomUUID()}.ogg`,
            );
            stream = fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 });
            stream.on('error', (error) => {
                this.failedStreams.add(stream!);
                console.error(`Ogg recording stream error for user ${userId}:`, error);
            });

            const muxer = new OggOpusMuxer();
            this.writeStreams.set(userId, stream);
            this.activeFilePaths.set(userId, filename);
            this.muxers.set(userId, muxer);
            stream.write(Buffer.concat(muxer.headers()));
        }

        try {
            const page = this.muxers.get(userId)!.packet(opusPacket);
            if (page.length > 0) stream.write(page);
        } catch (error) {
            this.failedStreams.add(stream);
            console.error(`Invalid Opus packet for user ${userId}:`, error);
        }
    }

    /** 現在の録音をEOSまで確定し、正常にcloseできたファイルだけを返す。 */
    async flushAudio(): Promise<Map<string, string>> {
        const recordings = await this.finalizeOpenRecordings();
        const failed = recordings.filter(({ stream }) => this.failedStreams.has(stream));

        if (failed.length > 0) {
            this.deleteRecordings(recordings);
            throw new Error(
                `Failed to finalize Ogg recording for user(s): ${failed.map(({ userId }) => userId).join(', ')}`,
            );
        }

        const files = new Map<string, string>();
        for (const { userId, filePath } of recordings) {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                files.set(userId, filePath);
            }
        }
        return files;
    }

    /** 異常終了用。EOSを書いてstreamを閉じた後、録音ファイルを破棄する。 */
    async discard(): Promise<void> {
        const recordings = await this.finalizeOpenRecordings();
        this.deleteRecordings(recordings);
    }

    hasData(): boolean {
        return this.writeStreams.size > 0;
    }

    private async finalizeOpenRecordings(): Promise<OpenRecording[]> {
        const recordings: OpenRecording[] = [];
        for (const [userId, stream] of this.writeStreams) {
            const filePath = this.activeFilePaths.get(userId);
            const muxer = this.muxers.get(userId);
            if (filePath && muxer) recordings.push({ userId, filePath, stream, muxer });
        }

        // close待ちの間に届くpacketは、次のOgg streamへ書けるよう先に世代を切り替える。
        this.writeStreams = new Map();
        this.activeFilePaths = new Map();
        this.muxers = new Map();

        await Promise.all(recordings.map(({ stream, muxer }) => new Promise<void>((resolve) => {
            if (stream.closed) {
                resolve();
                return;
            }
            stream.once('close', resolve);
            try {
                const eosPage = muxer.end();
                if (eosPage.length > 0) stream.end(eosPage);
                else stream.end();
            } catch (error) {
                this.failedStreams.add(stream);
                console.error('Failed to finalize Ogg recording stream:', error);
                stream.destroy();
            }
        })));

        return recordings;
    }

    private deleteRecordings(recordings: OpenRecording[]): void {
        for (const { filePath } of recordings) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (error) {
                console.error(`Error removing discarded recording ${filePath}:`, error);
            }
        }
    }
}
