import {
    createPartFromFunctionResponse,
    FunctionCallingConfigMode,
    GoogleGenAI,
} from '@google/genai';
import { searchWeb, WebSearchResult } from './searchTool';

export interface SearchTraceResult extends WebSearchResult {
    referenceId: string;
}

export interface SearchTrace {
    query: string;
    results: SearchTraceResult[];
}

interface GenerateWithWebSearchOptions {
    responseMimeType?: string;
    isThinkingModel?: boolean;
    maxSteps?: number;
    forceSearch?: boolean;
}

interface GenerateWithWebSearchResult {
    response: any;
    searchTrace: SearchTrace[];
}

const SEARCH_FUNCTION_NAME = 'search_web';

const SEARCH_FUNCTION_DECLARATION = {
    name: SEARCH_FUNCTION_NAME,
    description: 'DuckDuckGo を使って Web 検索を実行し、各結果に referenceId を付けて返します。回答では [参考1] のように referenceId を必ず引用してください。',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '検索したいクエリ',
            },
            limit: {
                type: 'integer',
                description: '取得したい件数。1から5。',
                minimum: 1,
                maximum: 5,
            },
        },
        required: ['query'],
    },
};

export function extractUrlsFromSearchTrace(searchTrace: SearchTrace[]): string[] {
    const urls = searchTrace.flatMap((trace) => trace.results.map((result) => result.url));
    return Array.from(new Set(urls));
}

export async function generateContentWithWebSearch(
    ai: GoogleGenAI,
    model: string,
    parts: any[],
    options: GenerateWithWebSearchOptions = {},
): Promise<GenerateWithWebSearchResult> {
    const {
        responseMimeType,
        isThinkingModel = false,
        maxSteps = 4,
        forceSearch = true,
    } = options;

    const contents: any[] = [
        {
            role: 'user',
            parts,
        },
    ];
    const searchTrace: SearchTrace[] = [];
    let hasAttemptedSearch = false;
    let nextReferenceNumber = 1;

    for (let step = 0; step < maxSteps; step++) {
        const configObj: any = {
            toolConfig: {
                functionCallingConfig: {
                    mode:
                        forceSearch && !hasAttemptedSearch
                            ? FunctionCallingConfigMode.ANY
                            : FunctionCallingConfigMode.AUTO,
                },
            },
            tools: [{ functionDeclarations: [SEARCH_FUNCTION_DECLARATION] }],
        };

        if (responseMimeType && (!forceSearch || hasAttemptedSearch)) {
            configObj.responseMimeType = responseMimeType;
        }
        if (isThinkingModel) {
            configObj.thinkingConfig = {
                thinkingLevel: 'HIGH' as any,
            };
        }

        const response = await ai.models.generateContent({
            model,
            contents,
            config: configObj,
        });

        const functionCalls = response.functionCalls || [];
        if (functionCalls.length === 0) {
            if (forceSearch && !hasAttemptedSearch) {
                throw new Error('Web検索を強制しましたが、search_web が呼ばれませんでした。');
            }
            return {
                response,
                searchTrace,
            };
        }

        const modelContent = response.candidates?.[0]?.content;
        if (!modelContent?.parts?.length) {
            throw new Error('モデルの function call content を履歴に追加できませんでした。');
        }

        // Preserve the full model content exactly as returned so Gemini 3 thought signatures survive.
        contents.push(modelContent);

        const functionResponseParts = [];
        for (const call of functionCalls) {
            const functionName = call.name || 'unknown_function';
            if (call.name !== SEARCH_FUNCTION_NAME) {
                functionResponseParts.push(
                    createPartFromFunctionResponse(call.id || '', functionName, {
                        error: `Unsupported function: ${functionName}`,
                    }),
                );
                continue;
            }

            const query = typeof call.args?.query === 'string' ? call.args.query.trim() : '';
            const limit =
                typeof call.args?.limit === 'number' && Number.isFinite(call.args.limit)
                    ? call.args.limit
                    : 5;

            hasAttemptedSearch = true;

            if (!query) {
                functionResponseParts.push(
                    createPartFromFunctionResponse(call.id || '', call.name, {
                        error: 'query is required',
                    }),
                );
                continue;
            }

            try {
                const results = await searchWeb(query, limit);
                const referencedResults: SearchTraceResult[] = results.map((result) => ({
                    ...result,
                    referenceId: `参考${nextReferenceNumber++}`,
                }));
                searchTrace.push({ query, results: referencedResults });
                console.log(`[Web Search] ${query} -> ${referencedResults.length} result(s)`);
                functionResponseParts.push(
                    createPartFromFunctionResponse(call.id || '', call.name, {
                        output: {
                            query,
                            results: referencedResults,
                        },
                    }),
                );
            } catch (error) {
                console.error(`[Web Search] ${query} failed:`, error);
                functionResponseParts.push(
                    createPartFromFunctionResponse(call.id || '', call.name, {
                        error: String(error),
                    }),
                );
            }
        }

        contents.push({
            role: 'user',
            parts: functionResponseParts,
        });
    }

    throw new Error('検索関数の呼び出し回数が上限に達しました。');
}
