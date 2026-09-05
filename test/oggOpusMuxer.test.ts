import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OggOpusMuxer, opusPacketSamples } from '../src/oggOpusMuxer';

interface OggPage {
    type: number;
    granule: number;
    serial: number;
    sequence: number;
    lacing: number[];
    payload: Buffer;
}

const temporaryDirectories: string[] = [];
const ffmpegPath = Bun.which('ffmpeg');
const ffprobePath = Bun.which('ffprobe');
const integrationTest = ffmpegPath && ffprobePath ? test : test.skip;

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

function parsePages(file: Buffer): OggPage[] {
    const pages: OggPage[] = [];
    let offset = 0;
    while (offset < file.length) {
        expect(file.subarray(offset, offset + 4).toString()).toBe('OggS');
        const segmentCount = file[offset + 26];
        const lacingOffset = offset + 27;
        const lacing = [...file.subarray(lacingOffset, lacingOffset + segmentCount)];
        const payloadOffset = lacingOffset + segmentCount;
        const payloadLength = lacing.reduce((sum, length) => sum + length, 0);
        const granuleLow = file.readUInt32LE(offset + 6);
        const granuleHigh = file.readUInt32LE(offset + 10);
        pages.push({
            type: file[offset + 5],
            granule: granuleLow + granuleHigh * 0x1_0000_0000,
            serial: file.readUInt32LE(offset + 14),
            sequence: file.readUInt32LE(offset + 18),
            lacing,
            payload: file.subarray(payloadOffset, payloadOffset + payloadLength),
        });
        offset = payloadOffset + payloadLength;
    }
    return pages;
}

function parsePackets(pages: OggPage[]): Buffer[] {
    const packets: Buffer[] = [];
    let parts: Buffer[] = [];
    let accumulatedLength = 0;

    for (const page of pages) {
        let payloadOffset = 0;
        for (const length of page.lacing) {
            parts.push(page.payload.subarray(payloadOffset, payloadOffset + length));
            accumulatedLength += length;
            payloadOffset += length;
            if (length < 255) {
                packets.push(Buffer.concat(parts, accumulatedLength));
                parts = [];
                accumulatedLength = 0;
            }
        }
    }
    expect(parts).toHaveLength(0);
    return packets;
}

function audioPacketsFromOgg(filePath: string): Buffer[] {
    const packets = parsePackets(parsePages(fs.readFileSync(filePath)));
    expect(packets[0].subarray(0, 8).toString()).toBe('OpusHead');
    expect(packets[1].subarray(0, 8).toString()).toBe('OpusTags');
    return packets.slice(2);
}

function muxPackets(packets: Buffer[]): Buffer {
    const muxer = new OggOpusMuxer();
    const output = [...muxer.headers()];
    for (const packet of packets) {
        const page = muxer.packet(packet);
        if (page.length > 0) output.push(page);
    }
    const eosPage = muxer.end();
    if (eosPage.length > 0) output.push(eosPage);
    return Buffer.concat(output);
}

function makeSource(frameDurationMs = 20, durationSeconds = 0.12): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogg-opus-source-'));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, 'source.ogg');
    run([
        ffmpegPath!, '-v', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(durationSeconds), '-ac', '2', '-c:a', 'libopus',
        '-frame_duration', String(frameDurationMs), sourcePath,
    ]);
    return sourcePath;
}

function writeTemporaryOgg(contents: Buffer): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogg-opus-output-'));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, 'generated.ogg');
    fs.writeFileSync(outputPath, contents);
    return outputPath;
}

function probe(filePath: string): { duration: number; output: string } {
    const output = run([
        ffprobePath!, '-v', 'error', '-show_entries',
        'stream=codec_name,sample_rate,channels', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1', filePath,
    ]);
    const duration = Number(output.match(/^duration=(.+)$/m)?.[1]);
    return { duration, output };
}

describe('opusPacketSamples', () => {
    test('maps SILK, Hybrid, and CELT frame durations at 48 kHz', () => {
        expect([0, 1, 2, 3].map((configuration) =>
            opusPacketSamples(Buffer.from([configuration << 3])),
        )).toEqual([480, 960, 1920, 2880]);
        expect([12, 13, 14, 15].map((configuration) =>
            opusPacketSamples(Buffer.from([configuration << 3])),
        )).toEqual([480, 960, 480, 960]);
        expect([16, 17, 18, 19].map((configuration) =>
            opusPacketSamples(Buffer.from([configuration << 3])),
        )).toEqual([120, 240, 480, 960]);
    });

    test('applies frame counts for packing codes 0, 1, 2, and 3', () => {
        const configuration = 16 << 3;
        expect(opusPacketSamples(Buffer.from([configuration | 0]))).toBe(120);
        expect(opusPacketSamples(Buffer.from([configuration | 1]))).toBe(240);
        expect(opusPacketSamples(Buffer.from([configuration | 2]))).toBe(240);
        expect(opusPacketSamples(Buffer.from([configuration | 3, 3]))).toBe(360);
    });
});

describe('OggOpusMuxer', () => {
    test('writes EOS on the only real packet with the correct 60 ms granule', () => {
        const output = muxPackets([Buffer.from([3 << 3])]);
        const pages = parsePages(output);
        const packets = parsePackets(pages).slice(2);
        expect(packets.map((packet) => packet.length)).toEqual([1]);
        expect(pages.at(-1)?.type & 0x04).toBe(0x04);
        expect(pages.at(-1)?.granule).toBe(2880);
    });

    test('keeps sequence, serial, granules, and EOS valid for multiple packets', () => {
        const output = muxPackets([
            Buffer.from([16 << 3]),
            Buffer.from([17 << 3]),
            Buffer.from([18 << 3]),
        ]);
        const pages = parsePages(output);
        expect(pages.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
        expect(new Set(pages.map(({ serial }) => serial)).size).toBe(1);
        expect(pages.slice(2).map(({ granule }) => granule)).toEqual([120, 360, 840]);
        expect(pages.slice(0, -1).every(({ type }) => (type & 0x04) === 0)).toBeTrue();
        expect(pages.at(-1)?.type & 0x04).toBe(0x04);
    });

    test('parses legal 255 and 510 byte packets without inventing empty packets', () => {
        const packet255 = Buffer.alloc(255, 1);
        const packet510 = Buffer.alloc(510, 1);
        packet255[0] = 16 << 3;
        packet510[0] = 16 << 3;
        const pages = parsePages(muxPackets([packet255, packet510]));
        expect(pages[2].lacing).toEqual([255, 0]);
        expect(pages[3].lacing).toEqual([255, 255, 0]);
        expect(parsePackets(pages).slice(2).map((packet) => packet.length)).toEqual([255, 510]);
    });

    test('does not create an audio packet for empty input', () => {
        const muxer = new OggOpusMuxer();
        expect(muxer.packet(Buffer.alloc(0))).toHaveLength(0);
        expect(muxer.end()).toHaveLength(0);
    });

    integrationTest('preserves real 60 ms packet duration and fully decodes', () => {
        // libopusのlookaheadを含めて60 ms境界に揃え、最終packetのpadding差を除外する。
        const sourcePath = makeSource(60, 1.0135);
        const sourcePackets = audioPacketsFromOgg(sourcePath);
        expect(sourcePackets.length).toBeGreaterThan(1);
        expect(sourcePackets.every((packet) => opusPacketSamples(packet) === 2880)).toBeTrue();

        const outputPath = writeTemporaryOgg(muxPackets(sourcePackets));
        const sourceProbe = probe(sourcePath);
        const outputProbe = probe(outputPath);
        expect(outputProbe.output).toContain('codec_name=opus');
        expect(outputProbe.output).toContain('sample_rate=48000');
        expect(outputProbe.output).toContain('channels=2');
        expect(sourceProbe.duration).toBeCloseTo(1.02, 2);
        expect(outputProbe.duration).toBeCloseTo(1.02, 2);
        expect(Math.abs(outputProbe.duration - sourceProbe.duration)).toBeLessThan(0.02);
        run([ffmpegPath!, '-v', 'error', '-i', outputPath, '-f', 'null', '-']);
    });
});
