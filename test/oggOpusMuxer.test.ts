import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OggOpusMuxer } from '../src/oggOpusMuxer';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function run(command: string[]): string {
    const result = Bun.spawnSync({ cmd: command, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        throw new Error(`${command[0]} failed: ${new TextDecoder().decode(result.stderr)}`);
    }
    return new TextDecoder().decode(result.stdout);
}

function audioPacketsFromOgg(filePath: string): Buffer[] {
    const file = fs.readFileSync(filePath);
    const packets: Buffer[] = [];
    let offset = 0;
    let packetParts: Buffer[] = [];

    while (offset < file.length) {
        expect(file.subarray(offset, offset + 4).toString()).toBe('OggS');
        const segmentCount = file[offset + 26];
        const lacingOffset = offset + 27;
        const payloadOffset = lacingOffset + segmentCount;
        let payloadCursor = payloadOffset;
        for (const length of file.subarray(lacingOffset, payloadOffset)) {
            packetParts.push(file.subarray(payloadCursor, payloadCursor + length));
            payloadCursor += length;
            if (length < 255) {
                packets.push(Buffer.concat(packetParts));
                packetParts = [];
            }
        }
        offset = payloadCursor;
    }

    expect(packetParts).toHaveLength(0);
    expect(packets[0].subarray(0, 8).toString()).toBe('OpusHead');
    expect(packets[1].subarray(0, 8).toString()).toBe('OpusTags');
    return packets.slice(2);
}

function pages(filePath: string): Array<{ type: number; lacing: number[] }> {
    const file = fs.readFileSync(filePath);
    const output: Array<{ type: number; lacing: number[] }> = [];
    let offset = 0;
    while (offset < file.length) {
        expect(file.subarray(offset, offset + 4).toString()).toBe('OggS');
        const segmentCount = file[offset + 26];
        const lacingOffset = offset + 27;
        const lacing = [...file.subarray(lacingOffset, lacingOffset + segmentCount)];
        output.push({ type: file[offset + 5], lacing });
        offset = lacingOffset + segmentCount + lacing.reduce((sum, length) => sum + length, 0);
    }
    return output;
}

function makeSourcePackets(): Buffer[] {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogg-opus-muxer-source-'));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, 'source.ogg');
    run([
        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '0.12', '-ac', '2', '-c:a', 'libopus', sourcePath,
    ]);
    return audioPacketsFromOgg(sourcePath);
}

function muxAndVerify(packetCount: number): void {
    const packets = makeSourcePackets().slice(0, packetCount);
    expect(packets).toHaveLength(packetCount);
    const muxer = new OggOpusMuxer();
    const output = [...muxer.headers()];
    for (const packet of packets) {
        const page = muxer.packet(packet);
        if (page.length > 0) output.push(page);
    }
    const eosPage = muxer.end();
    if (eosPage.length > 0) output.push(eosPage);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogg-opus-muxer-output-'));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, 'generated.ogg');
    fs.writeFileSync(outputPath, Buffer.concat(output));

    const outputPages = pages(outputPath);
    expect(outputPages.at(-1)?.type & 0x04).toBe(0x04);
    // 音声ページに空packet（lacing value 0）が混ざっていないこと。
    for (const page of outputPages.slice(2)) expect(page.lacing).not.toContain(0);

    const probe = run([
        'ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels',
        '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', outputPath,
    ]);
    expect(probe).toContain('codec_name=opus');
    expect(probe).toContain('sample_rate=48000');
    expect(probe).toContain('channels=2');
    run(['ffmpeg', '-v', 'error', '-i', outputPath, '-f', 'null', '-']);
}

describe('OggOpusMuxer', () => {
    test('writes EOS on the only real Opus packet and remains fully decodable', () => {
        muxAndVerify(1);
    });

    test('writes EOS on the final real Opus packet for multiple packets', () => {
        muxAndVerify(3);
    });

    test('does not create an Ogg audio packet for empty input', () => {
        const muxer = new OggOpusMuxer();
        expect(muxer.packet(Buffer.alloc(0))).toHaveLength(0);
        expect(muxer.end()).toHaveLength(0);
    });
});
