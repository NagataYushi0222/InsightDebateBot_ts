import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from '../src/asyncPool';

describe('mapWithConcurrency', () => {
    test('limits active work and preserves input order', async () => {
        let active = 0;
        let maxActive = 0;
        const result = await mapWithConcurrency([30, 5, 20, 10, 15], 2, async (delay, index) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, delay));
            active -= 1;
            return index;
        });

        expect(maxActive).toBe(2);
        expect(result).toEqual([0, 1, 2, 3, 4]);
    });

    test('waits for in-flight work before rejecting', async () => {
        let inFlightCompleted = false;
        const failure = new Error('upload failed');

        await expect(mapWithConcurrency([0, 1, 2], 2, async (item) => {
            if (item === 0) throw failure;
            await new Promise((resolve) => setTimeout(resolve, 10));
            inFlightCompleted = true;
            return item;
        })).rejects.toBe(failure);

        expect(inFlightCompleted).toBe(true);
    });
});
