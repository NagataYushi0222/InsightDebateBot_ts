import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from './config';
import { OggOpusMuxer } from './oggOpusMuxer';

export interface RecordingQuality {
    totalPackets: number;
    acceptedPackets: number;
    droppedPackets: number;
    consecutiveDroppedPackets: number;
    maxConsecutiveDroppedPackets: number;
    hardFailure: boolean;
    firstPacketError?: string;
    lastPacketError?: string;
}

interface OpenRecording {
    userId: string;
    filePath: string;
    stream: fs.WriteStream;
    muxer: OggOpusMuxer;
    quality: RecordingQuality;
}

function emptyQuality(): RecordingQuality {
    return {
        totalPackets: 0,
        acceptedPackets: 0,
        droppedPackets: 0,
        consecutiveDroppedPackets: 0,
        maxConsecutiveDroppedPackets: 0,
        hardFailure: false,
    };
}

/** ユーザー別のOpus packetを再エンコードせずOggへ書き出す。 */
export class UserAudioRecorder {
    private writeStreams = new Map<string, fs.WriteStream>();
    private activeFilePaths = new Map<string, string>();
    private muxers = new Map<string, OggOpusMuxer>();
    private qualities = new Map<string, RecordingQuality>();
    private readonly hardFailedStreams = new WeakSet<fs.WriteStream>();

    constructor(private readonly outputDirectory: string = TEMP_AUDIO_DIR) {
        fs.mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 });
    }

    writeOpus(userId: string, opusPacket: Buffer): void {
        if (opusPacket.length === 0) return;

        let stream = this.writeStreams.get(userId);
        let quality = this.qualities.get(userId);
        if (!stream) {
            const filename = path.join(
                this.outputDirectory,
                `recording_${userId}_${Date.now()}_${crypto.randomUUID()}.ogg`,
            );
            stream = fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 });
            quality = emptyQuality();
            stream.on('error', (error) => {
                quality!.hardFailure = true;
                this.hardFailedStreams.add(stream!);
                console.error(`Ogg recording stream error for user ${userId}:`, error);
            });

            const muxer = new OggOpusMuxer();
            this.writeStreams.set(userId, stream);
            this.activeFilePaths.set(userId, filename);
            this.muxers.set(userId, muxer);
            this.qualities.set(userId, quality);
            stream.write(Buffer.concat(muxer.headers()));
        }

        quality!.totalPackets += 1;

        try {
            const page = this.muxers.get(userId)!.packet(opusPacket);
            if (page.length > 0) stream.write(page);
            quality!.acceptedPackets += 1;
            quality!.consecutiveDroppedPackets = 0;
        } catch (error) {
            quality!.droppedPackets += 1;
            quality!.consecutiveDroppedPackets += 1;
            if (quality!.consecutiveDroppedPackets > quality!.maxConsecutiveDroppedPackets) {
                quality!.maxConsecutiveDroppedPackets = quality!.consecutiveDroppedPackets;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (!quality!.firstPacketError) quality!.firstPacketError = message;
            quality!.lastPacketError = message;
            if (quality!.droppedPackets <= 5 || quality!.droppedPackets % 100 === 0) {
                console.warn(
                    `[Recorder] Dropped invalid Opus packet for user ${userId} (${quality!.droppedPackets} total dropped):`,
                    message,
                );
            }
        }
    }

    /** 現在の録音をEOSまで確定し、正常にcloseできたファイルだけを返す。 */
    async flushAudio(): Promise<Map<string, string>> {
        const recordings = await this.finalizeOpenRecordings();

        const files = new Map<string, string>();
        for (const { userId, filePath, quality } of recordings) {
            this.logQuality(userId, quality);
            if (quality.hardFailure) {
                this.deleteRecording(filePath);
                continue;
            }
            if (quality.acceptedPackets === 0) {
                this.deleteRecording(filePath);
                continue;
            }
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                files.set(userId, filePath);
            }
        }
        return files;
    }

    /** 異常終了用。EOSを書いてstreamを閉じた後、録音ファイルを破棄する。 */
    async discard(): Promise<void> {
        const recordings = await this.finalizeOpenRecordings();
        for (const { filePath } of recordings) {
            this.deleteRecording(filePath);
        }
    }

    hasData(): boolean {
        return this.writeStreams.size > 0;
    }

    private async finalizeOpenRecordings(): Promise<OpenRecording[]> {
        const recordings: OpenRecording[] = [];
        for (const [userId, stream] of this.writeStreams) {
            const filePath = this.activeFilePaths.get(userId);
            const muxer = this.muxers.get(userId);
            const quality = this.qualities.get(userId) ?? emptyQuality();
            if (filePath && muxer) recordings.push({ userId, filePath, stream, muxer, quality });
        }

        // close待ちの間に届くpacketは、次のOgg streamへ書けるよう先に世代を切り替える。
        this.writeStreams = new Map();
        this.activeFilePaths = new Map();
        this.muxers = new Map();
        this.qualities = new Map();

        await Promise.all(recordings.map(({ stream, muxer, quality }) => new Promise<void>((resolve) => {
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
                quality.hardFailure = true;
                this.hardFailedStreams.add(stream);
                console.error('Failed to finalize Ogg recording stream:', error);
                stream.destroy();
            }
        })));

        return recordings;
    }

    private deleteRecording(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (error) {
            console.error(`Error removing discarded recording ${filePath}:`, error);
        }
    }

    private logQuality(userId: string, quality: RecordingQuality): void {
        if (quality.totalPackets === 0 && !quality.hardFailure) return;
        const parts = [
            `[Recorder][quality] user=${userId}`,
            `total=${quality.totalPackets}`,
            `accepted=${quality.acceptedPackets}`,
            `dropped=${quality.droppedPackets}`,
            `max_consecutive_dropped=${quality.maxConsecutiveDroppedPackets}`,
        ];
        if (quality.hardFailure) parts.push('HARD_FAILURE');
        if (quality.firstPacketError) parts.push(`first_error="${quality.firstPacketError}"`);
        console.log(parts.join(' '));
    }
}
