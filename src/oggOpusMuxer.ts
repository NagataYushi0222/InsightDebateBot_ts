import crypto from 'crypto';

const CRC_TABLE = new Uint32Array(256);
const SILK_FRAME_SAMPLES = [480, 960, 1920, 2880] as const;

for (let i = 0; i < 256; i += 1) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 0x80000000)
            ? ((value << 1) ^ 0x04c11db7)
            : (value << 1);
    }
    CRC_TABLE[i] = value >>> 0;
}

function crc32(buffer: Buffer): number {
    let crc = 0;
    for (const byte of buffer) {
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    }
    return crc >>> 0;
}

/** RFC 6716 のTOCから、48 kHz基準のpacket durationをsample数で返す。 */
export function opusPacketSamples(packet: Buffer): number {
    if (packet.length === 0) throw new Error('Opus packet must not be empty');

    const toc = packet[0];
    const configuration = toc >> 3;
    const packingCode = toc & 0x03;
    let frameCount: number;

    if (packingCode === 0) {
        frameCount = 1;
    } else if (packingCode === 1 || packingCode === 2) {
        frameCount = 2;
    } else {
        if (packet.length < 2) throw new Error('Opus code 3 packet is missing its frame count byte');
        frameCount = packet[1] & 0x3f;
        if (frameCount === 0) throw new Error('Opus code 3 packet has no frames');
    }

    const frameSamples = configuration < 12
        ? SILK_FRAME_SAMPLES[configuration & 0x03]
        : configuration < 16
            ? 480 << (configuration & 0x01)
            : 120 << (configuration & 0x03);
    const packetSamples = frameSamples * frameCount;

    // Opus packetの合計durationは仕様上120 ms以下。
    if (packetSamples > 5760) {
        throw new Error(`Invalid Opus packet duration: ${packetSamples} samples`);
    }
    return packetSamples;
}

/** DiscordのDAVE復号済みOpusを再エンコードせず、正規のOgg/Opusページへ格納する。 */
export class OggOpusMuxer {
    private readonly serial = crypto.randomBytes(4).readUInt32LE();
    private sequence = 0;
    private granule = 0;
    private pendingPacket: Buffer | null = null;
    private pendingGranule = 0;

    headers(): Buffer[] {
        const head = Buffer.alloc(19);
        head.write('OpusHead');
        head[8] = 1;
        head[9] = 2;
        head.writeUInt32LE(48_000, 12);

        const vendor = Buffer.from('InsightDebateBot');
        const tags = Buffer.alloc(16 + vendor.length);
        tags.write('OpusTags');
        tags.writeUInt32LE(vendor.length, 8);
        vendor.copy(tags, 12);

        return [this.page(head, 2, 0), this.page(tags, 0, 0)];
    }

    packet(packet: Buffer): Buffer {
        if (packet.length === 0) return Buffer.alloc(0);

        this.granule += opusPacketSamples(packet);
        const output = this.pendingPacket
            ? this.page(this.pendingPacket, 0, this.pendingGranule)
            : Buffer.alloc(0);

        this.pendingPacket = Buffer.from(packet);
        this.pendingGranule = this.granule;
        return output;
    }

    end(): Buffer {
        if (!this.pendingPacket) return Buffer.alloc(0);

        const output = this.page(this.pendingPacket, 4, this.pendingGranule);
        this.pendingPacket = null;
        return output;
    }

    private page(payload: Buffer, type: number, granule: number): Buffer {
        const lacing: number[] = [];
        for (let remaining = payload.length; remaining >= 255; remaining -= 255) {
            lacing.push(255);
        }
        lacing.push(payload.length % 255);

        const header = Buffer.alloc(27 + lacing.length);
        header.write('OggS');
        header[5] = type;
        header.writeUInt32LE(granule >>> 0, 6);
        header.writeUInt32LE(Math.floor(granule / 0x1_0000_0000), 10);
        header.writeUInt32LE(this.serial, 14);
        header.writeUInt32LE(this.sequence++, 18);
        header[26] = lacing.length;
        Buffer.from(lacing).copy(header, 27);

        const page = Buffer.concat([header, payload]);
        page.writeUInt32LE(crc32(page), 22);
        return page;
    }
}
