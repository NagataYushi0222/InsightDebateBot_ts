/**
 * OpusScript を使用した Opus デコーダーのラッパー
 * discord.js の音声受信から来る Opus パケットを PCM に変換する
 */
export class OpusDecoder {
    private decoder: any = null;
    private destroyed = false;

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
        if (this.destroyed || !this.decoder) {
            return null;
        }

        try {
            const pcm = this.decoder.decode(packet);
            return Buffer.from(pcm);
        } catch {
            return null;
        }
    }

    /**
     * デコーダーを破棄
     */
    destroy(): void {
        if (this.destroyed) {
            return;
        }

        const decoder = this.decoder;
        this.destroyed = true;
        this.decoder = null;

        if (decoder && typeof decoder.delete === 'function') {
            try {
                decoder.delete();
            } catch (error) {
                console.warn('Failed to destroy OpusScript decoder:', error);
            }
        }
    }
}
