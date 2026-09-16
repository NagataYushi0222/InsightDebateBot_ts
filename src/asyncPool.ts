export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('concurrency must be a positive integer');
    }

    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let firstError: unknown;

    const worker = async (): Promise<void> => {
        while (firstError === undefined) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) return;

            try {
                results[index] = await mapper(items[index], index);
            } catch (error) {
                firstError ??= error;
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
    );

    if (firstError !== undefined) throw firstError;
    return results;
}
