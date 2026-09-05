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

describe('UserAudioRecorder', () => {
    test('rotates streams safely across consecutive flush cycles', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', Buffer.from([16 << 3]));

        const firstFlush = recorder.flushAudio();
        recorder.writeOpus('user-1', Buffer.from([17 << 3]));

        const first = await firstFlush;
        const second = await recorder.flushAudio();
        expect(first.get('user-1')).not.toBe(second.get('user-1'));
        expect([...first.values(), ...second.values()].every((file) => fs.existsSync(file))).toBeTrue();
    });

    test('discard closes the stream and removes the temporary Ogg file', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', Buffer.from([16 << 3]));
        expect(recorder.hasData()).toBeTrue();

        await recorder.discard();

        expect(recorder.hasData()).toBeFalse();
        expect(fs.readdirSync(directory)).toHaveLength(0);
    });

    test('never returns a recording whose Opus packet validation failed', async () => {
        const directory = temporaryDirectory();
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', Buffer.from([(16 << 3) | 3]));

        await expect(recorder.flushAudio()).rejects.toThrow('Failed to finalize Ogg recording');
        expect(fs.readdirSync(directory)).toHaveLength(0);
    });
});
