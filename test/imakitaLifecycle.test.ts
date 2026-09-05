import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { VoiceConnection } from '@ovencord/voice';
import { ImakitaSession } from '../src/imakitaSession';
import { UserAudioRecorder } from '../src/recorder';
import { VcArticleSession } from '../src/vcArticle/sessionManager';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('ImakitaSession destroyed lifecycle', () => {
    test('stops recording and timer, releases recorder, and deletes its open Ogg', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'imakita-destroyed-'));
        directories.push(directory);
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', Buffer.from([16 << 3]));

        const connection = { state: { status: 'destroyed' } } as unknown as VoiceConnection;
        const session = new ImakitaSession();
        const internal = session as unknown as {
            recorder: UserAudioRecorder | null;
            timer: ReturnType<typeof setInterval> | null;
            detach: (() => void) | null;
        };
        let detached = false;
        internal.recorder = recorder;
        internal.timer = setInterval(() => undefined, 60_000);
        internal.detach = () => { detached = true; };
        session.voiceConnection = connection;
        session.isRecording = true;

        expect(session.handleDestroyedConnection(connection)).toBeTrue();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(session.isRecording).toBeFalse();
        expect(session.voiceConnection).toBeNull();
        expect(internal.recorder).toBeNull();
        expect(internal.timer).toBeNull();
        expect(detached).toBeTrue();
        expect(fs.readdirSync(directory)).toHaveLength(0);
    });
});

describe('VcArticleSession destroyed lifecycle', () => {
    test('stops its timer and discards the open recorder', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'article-destroyed-'));
        directories.push(directory);
        const recorder = new UserAudioRecorder(directory);
        recorder.writeOpus('user-1', Buffer.from([16 << 3]));

        const connection = { state: { status: 'destroyed' } } as unknown as VoiceConnection;
        const session = new VcArticleSession('guild-1');
        const internal = session as unknown as {
            recorder: UserAudioRecorder | null;
            chunkTimer: ReturnType<typeof setInterval> | null;
            detachVoiceCapture: (() => void) | null;
        };
        let detached = false;
        internal.recorder = recorder;
        internal.chunkTimer = setInterval(() => undefined, 60_000);
        internal.detachVoiceCapture = () => { detached = true; };
        session.voiceConnection = connection;
        session.isRecording = true;

        expect(session.handleDestroyedConnection(connection)).toBeTrue();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(session.isRecording).toBeFalse();
        expect(session.voiceConnection).toBeNull();
        expect(internal.recorder).toBeNull();
        expect(internal.chunkTimer).toBeNull();
        expect(detached).toBeTrue();
        expect(fs.readdirSync(directory)).toHaveLength(0);
    });
});
