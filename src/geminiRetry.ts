const DEFAULT_INVALID_ARGUMENT_RETRY_DELAY_MS = 1_500;

function extractGeminiError(error: any): any {
    if (error?.error) return error.error;
    if (error?.response?.data?.error) return error.response.data.error;

    if (typeof error?.message === 'string') {
        try {
            const parsed = JSON.parse(error.message);
            return parsed?.error ?? parsed;
        } catch {
            // JSON ではない通常の Error.message は下でそのまま判定する。
        }
    }

    return error ?? {};
}

export function isGeminiInvalidArgument(error: unknown): boolean {
    const source = extractGeminiError(error);
    return source?.code === 400
        || source?.status === 'INVALID_ARGUMENT'
        || error instanceof Error && /INVALID_ARGUMENT/.test(error.message);
}

export async function retryGeminiInvalidArgument<T>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
    options: {
        delayMs?: number;
        onRetry?: (error: unknown) => void;
    } = {},
): Promise<T> {
    try {
        return await primary();
    } catch (error) {
        if (!isGeminiInvalidArgument(error)) throw error;

        options.onRetry?.(error);
        const delayMs = options.delayMs ?? DEFAULT_INVALID_ARGUMENT_RETRY_DELAY_MS;
        if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return fallback();
    }
}
