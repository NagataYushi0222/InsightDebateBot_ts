import { describe, expect, test } from 'bun:test';
import {
    isGeminiInvalidArgument,
    retryGeminiInvalidArgument,
} from '../src/geminiRetry';

describe('Gemini INVALID_ARGUMENT retry', () => {
    test('recognizes SDK errors whose JSON body is stored in message', () => {
        const error = new Error(JSON.stringify({
            error: {
                code: 400,
                message: 'Request contains an invalid argument.',
                status: 'INVALID_ARGUMENT',
            },
        }));

        expect(isGeminiInvalidArgument(error)).toBe(true);
    });

    test('retries INVALID_ARGUMENT once with the fallback operation', async () => {
        let fallbackCalls = 0;
        const result = await retryGeminiInvalidArgument(
            async () => {
                throw Object.assign(new Error('bad request'), { status: 'INVALID_ARGUMENT' });
            },
            async () => {
                fallbackCalls += 1;
                return 'recovered';
            },
            { delayMs: 0 },
        );

        expect(result).toBe('recovered');
        expect(fallbackCalls).toBe(1);
    });

    test('does not retry quota failures', async () => {
        let fallbackCalls = 0;
        const error = Object.assign(new Error('quota exhausted'), { code: 429, status: 'RESOURCE_EXHAUSTED' });

        await expect(retryGeminiInvalidArgument(
            async () => { throw error; },
            async () => {
                fallbackCalls += 1;
                return 'unexpected';
            },
            { delayMs: 0 },
        )).rejects.toBe(error);
        expect(fallbackCalls).toBe(0);
    });
});
