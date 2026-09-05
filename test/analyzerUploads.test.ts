import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import { DiscussionAudioInput, uploadDiscussionAudioInputs } from '../src/analyzer';

const directories: string[] = [];

function inputs(): DiscussionAudioInput[] {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-upload-'));
    directories.push(directory);
    return ['A', 'B', 'C'].map((userId, index) => {
        const filePath = path.join(directory, `${userId}.ogg`);
        fs.writeFileSync(filePath, userId);
        return { userId, segmentId: `${userId}:1`, partIndex: index + 1, filePath };
    });
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('uploadDiscussionAudioInputs', () => {
    test('aborts and cleans up when A succeeds and B fails, without attempting C', async () => {
        const uploaded: string[] = [];
        const deleted: string[] = [];
        const ai = {
            files: {
                upload: async ({ file }: { file: string }) => {
                    const userId = path.basename(file, '.ogg');
                    uploaded.push(userId);
                    if (userId === 'B') throw new Error('simulated upload failure');
                    return { name: `files/${userId}`, uri: `gemini://${userId}`, mimeType: 'audio/ogg' };
                },
                delete: async ({ name }: { name: string }) => { deleted.push(name); },
            },
        } as unknown as GoogleGenAI;

        await expect(uploadDiscussionAudioInputs(ai, inputs(), null)).rejects.toThrow('simulated upload failure');
        expect(uploaded).toEqual(['A', 'B']);
        expect(deleted).toEqual(['files/A']);
    });

    test('keeps Discord user identity separate from segment identity', async () => {
        const ai = {
            files: {
                upload: async ({ file }: { file: string }) => {
                    const userId = path.basename(file, '.ogg');
                    return { name: `files/${userId}`, uri: `gemini://${userId}`, mimeType: 'audio/ogg' };
                },
                delete: async () => undefined,
            },
        } as unknown as GoogleGenAI;
        const repeatedUserInputs = inputs().slice(0, 2).map((input, index) => ({
            ...input,
            userId: '123456789',
            segmentId: `segment-${index + 1}`,
            partIndex: index + 1,
        }));

        const result = await uploadDiscussionAudioInputs(ai, repeatedUserInputs, null);
        const labels = result.audioParts.filter((part) => 'text' in part).map((part) => part.text);
        expect(labels).toEqual([
            '発言者ラベル: User_123456789 [ID:123456789] / segment=segment-1 / part=1',
            '発言者ラベル: User_123456789 [ID:123456789] / segment=segment-2 / part=2',
        ]);
        expect(labels.join('\n')).not.toContain('__part');
    });
});
