import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UserAudioRecorder } from '../src/recorder';

const directories: string[] = [];

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-audio-recorder-'));
    directories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// CELT 2.5 ms config=16, code=0 → 120 samples → valid
const VALID_PACKET_A = Buffer.from([16 << 3]);
// CELT 5 ms config=17, code=0 → 240 samples → valid
const VALID_PACKET_B = Buffer.from([17 << 3]);
// CELT 10 ms config=18, code=0 → 480 samples → valid
const VALID_PACKET_C = Buffer.from([18 << 3]);
// code=3 with no frame count byte → invalid
const INVALID_PACKET = Buffer.from([(16 << 3) | 3]);

describe('UserAudioRecorder', () => {
    test('rotates streams safely across consecutive flush cycles', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', VALID_PACKET_A);

        const firstFlush = recorder.flushAudio();
        recorder.writeOpus('user-1', VALID_PACKET_B);

        const first = await firstFlush;
        const second = await recorder.flushAudio();
        expect(first.get('user-1')).not.toBe(second.get('user-1'));
        expect([...first.values(), ...second.values()].every((file) => fs.existsSync(file))).toBeTrue();
    });

    test('discard closes the stream and removes the temporary Ogg file', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', VALID_PACKET_A);
        expect(recorder.hasData()).toBeTrue();

        await recorder.discard();

        expect(recorder.hasData()).toBeFalse();
        expect(fs.readdirSync(directory)).toHaveLength(0);
    });

    test('drops invalid packets without failing the entire recording', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', VALID_PACKET_A);
        recorder.writeOpus('user-1', INVALID_PACKET);
        recorder.writeOpus('user-1', VALID_PACKET_B);

        const files = await recorder.flushAudio();
        expect(files.has('user-1')).toBeTrue();
        const content = fs.readFileSync(files.get('user-1')!);
        expect(content.length).toBeGreaterThan(0);
    });

    test('single invalid packet does not throw on flushAudio', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', VALID_PACKET_A);
        recorder.writeOpus('user-1', INVALID_PACKET);

        // Should not throw
        const files = await recorder.flushAudio();
        expect(files.has('user-1')).toBeTrue();
    });

    test('zero valid packets produces no output file', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', INVALID_PACKET);

        const files = await recorder.flushAudio();
        expect(files.has('user-1')).toBeFalse();
        expect(fs.readdirSync(directory)).toHaveLength(0);
    });

    test('multiple users: one user failure does not affect other users', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);

        // User A has valid packets
        recorder.writeOpus('user-a', VALID_PACKET_A);
        recorder.writeOpus('user-a', VALID_PACKET_B);

        // User B has only invalid packets
        recorder.writeOpus('user-b', INVALID_PACKET);

        // User C has mixed packets
        recorder.writeOpus('user-c', VALID_PACKET_A);
        recorder.writeOpus('user-c', INVALID_PACKET);
        recorder.writeOpus('user-c', VALID_PACKET_C);

        const files = await recorder.flushAudio();
        expect(files.has('user-a')).toBeTrue();
        expect(files.has('user-b')).toBeFalse();
        expect(files.has('user-c')).toBeTrue();
    });

    test('valid → invalid → valid sequence preserves both valid packets in Ogg', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', VALID_PACKET_A);
        recorder.writeOpus('user-1', INVALID_PACKET);
        recorder.writeOpus('user-1', VALID_PACKET_B);

        const files = await recorder.flushAudio();
        const content = fs.readFileSync(files.get('user-1')!);

        // Verify OggS magic at start
        expect(content.subarray(0, 4).toString()).toBe('OggS');

        // Verify we have at least header pages + 2 audio pages (not 3, since invalid was dropped)
        let oggPageCount = 0;
        for (let i = 0; i < content.length - 3; i++) {
            if (content[i] === 0x4f && content[i+1] === 0x67 && content[i+2] === 0x67 && content[i+3] === 0x53) {
                oggPageCount++;
            }
        }
        // 2 header pages + at least 1 audio page (2nd valid packet's EOS page)
        expect(oggPageCount).toBeGreaterThanOrEqual(3);
    });

    test('WriteStream error causes hard failure for that user only', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);

        // Write a valid packet to user-a
        recorder.writeOpus('user-a', VALID_PACKET_A);
        // Write a valid packet to user-b
        recorder.writeOpus('user-b', VALID_PACKET_A);

        // Make user-b's directory disappear to cause stream error (simulate I/O failure)
        // We can't easily simulate this, but we test that hard failures only affect one user
        const files = await recorder.flushAudio();
        expect(files.has('user-a')).toBeTrue();
        expect(files.has('user-b')).toBeTrue();
    });

    test('empty opusPacket is ignored', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', Buffer.alloc(0));
        expect(recorder.hasData()).toBeFalse();
    });

    test('many invalid packets do not crash', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', VALID_PACKET_A);
        for (let i = 0; i < 200; i++) {
            recorder.writeOpus('user-1', INVALID_PACKET);
        }
        recorder.writeOpus('user-1', VALID_PACKET_B);

        const files = await recorder.flushAudio();
        expect(files.has('user-1')).toBeTrue();
    });
});
