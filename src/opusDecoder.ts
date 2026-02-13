/**
 * OpusScript を使用した Opus デコーダーのラッパー
 * discord.js の音声受信から来る Opus パケットを PCM に変換する
 */
export class OpusDecoder {
    private decoder: any;

    constructor(sampleRate: number = 48000, channels: number = 2) {
        try {
            const OpusScript = require('opusscript');
            this.decoder = new OpusScript(sampleRate, channels, OpusScript.Application.AUDIO);
        } catch (e) {
            console.error('Failed to initialize OpusScript decoder:', e);
            throw e;
        }
    }

    /**
     * Opus パケットを PCM にデコード
     * @returns PCM Buffer (signed 16-bit little-endian)
     */
    decode(packet: Buffer): Buffer | null {
        try {
            const pcm = this.decoder.decode(packet);
            return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        } catch {
            return null;
        }
    }

    /**
     * デコーダーを破棄
     */
    destroy(): void {
        if (this.decoder && typeof this.decoder.delete === 'function') {
            this.decoder.delete();
        }
    }
}
