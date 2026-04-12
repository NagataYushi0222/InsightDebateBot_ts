import {
    createPartFromFunctionCall,
    createPartFromFunctionResponse,
    FunctionCallingConfigMode,
    GoogleGenAI,
} from '@google/genai';
import fs from 'fs';
import { GEMINI_API_KEY, GEMINI_MODEL_FLASH } from './config';
import { searchWeb } from './searchTool';

function extractReferenceUrls(response: any): string[] {
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];

    const urls = chunks
        .map((chunk: any) => chunk?.web?.uri)
        .filter((uri: unknown): uri is string => typeof uri === 'string' && uri.length > 0);

    return Array.from(new Set(urls));
}

function appendReferenceUrls(reportText: string, response: any): string {
    const urls = extractReferenceUrls(response);
    if (reportText.includes('【参考URL】')) {
        return reportText;
    }

    if (urls.length === 0) {
        return reportText;
    }

    const referenceSection = `【参考URL】\n${urls.map((url) => `- ${url}`).join('\n')}`;

    return `${reportText}\n\n${referenceSection}`;
}

/**
 * 分析プロンプト定義
 */
const PROMPTS: Record<string, string> = {
    debate: `
あなたはプロの議論アナリスト兼ファクトチェッカーです。提供された複数の音声ファイル（各ファイル名にユーザーIDまたは名前が含まれる）を分析し、以下の形式でレポートを作成してください。

分析ルール:
1. 各ファイルの声とユーザー名を正確に紐付けてください。
1.5. **各音声ファイルの直前に書かれた「発言者ラベル」が、そのファイルの唯一の話者です。別ファイルの発言をその人に混ぜないでください。話者が確信できない内容は「不明」としてください。**
2. **検索によるファクトチェックは必須です**。議論の中で出た事実（例：「現在の失業率は〜」「〇〇というニュースがあった」）について、提供された Web 検索機能を使って最新情報を確認してください。
3. 以前の発言と矛盾している点があれば指摘してください。
4. **【重要】音声が無音、ノイズのみ、または意味のある会話が含まれていない場合は、無理に分析せず、「特に新しい議論はありませんでした。」とだけ出力してください。幻覚（ハルシネーション）を起こさないでください。**
5. 「前回の文脈」はあくまで参考情報です。**今回提供された音声ファイルに含まれていない発言を、前回の文脈から捏造してレポートに含めないでください。**
6. **ある参加者の発言を別の参加者に割り当てることは禁止です。**

出力項目:
【議論の要約】: (300字以内)
【各ユーザーの立場】: (ユーザー名: 賛成/反対/中立などの属性と主要な意見)
【現在の対立構造】: (何がボトルネックで合意に至っていないか)
【争点と矛盾・ファクトチェック】: (発言の矛盾点や、最新のネット情報と照らし合わせた誤りの指摘)
【対立点の折衷案】: (対立点を解決するための折衷案の提案)
【参考URL】: (Web検索で参照したURLを箇条書きで必ず列挙。最低1件。URLは省略せずフルで書く)

**前置き・挨拶・自己紹介は一切不要です。上記の出力項目のみをそのまま出力してください。**
`,
    summary: `
あなたは会議の書記です。提供された音声ファイルを分析し、途中から参加した人でも状況がわかるような親切な要約を作成してください。

分析ルール:
1. 誰が何について話しているかを明確にしてください。
1.5. **各音声ファイルの直前に書かれた「発言者ラベル」が、そのファイルの唯一の話者です。別ファイルの発言をその人に混ぜないでください。話者が確信できない内容は「不明」としてください。**
2. 専門用語や文脈依存の単語には簡単な補足を加えてください。
3. **【重要】音声が無音、ノイズのみ、または意味のある会話が含まれていない場合は、無理に分析せず、「特に新しい議論はありませんでした。」とだけ出力してください。**
4. 「前回の文脈」はあくまで参考情報です。**今回提供された音声ファイルに含まれていない発言を、前回の文脈から捏造してレポートに含めないでください。**
5. **ある参加者の発言を別の参加者に割り当てることは禁止です。**

出力項目:
【現在のトピック】: (今何を話しているか、数行でシンプルに)
【これまでの流れ】: (時系列で主な発言と決定事項を箇条書き)
【未解決の課題】: (まだ決まっていないこと、次に話すべきこと)
【参加者の発言要旨】: (各参加者の主な主張)
【参考URL】: (Web検索で参照したURLを箇条書きで必ず列挙。最低1件。URLは省略せずフルで書く)

**前置き・挨拶・自己紹介は一切不要です。上記の出力項目のみをそのまま出力してください。**
`,
};

/**
 * Gemini File APIに音声ファイルをアップロード
 */
async function uploadToGemini(
    ai: GoogleGenAI,
    filePath: string,
    mimeType: string = 'audio/mp3'
) {
    try {
        const fileRef = await ai.files.upload({
            file: filePath,
            config: { mimeType },
        });
        return fileRef;
    } catch (e) {
        console.error(`Upload failed: ${e}`);
        throw e;
    }
}

/**
 * アップロードしたファイルがACTIVE状態になるまで待機
 */
async function waitForFilesActive(
    ai: GoogleGenAI,
    files: any[]
): Promise<void> {
    console.log('Waiting for file processing...');
    for (const fileRef of files) {
        while (true) {
            try {
                const currentFile = await ai.files.get({ name: fileRef.name });
                if (currentFile.state === 'ACTIVE') {
                    break;
                }
                if (currentFile.state === 'FAILED') {
                    throw new Error(`File ${currentFile.name} failed to process`);
                }
                process.stdout.write('.');
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (e) {
                console.error(`Error checking file state: ${e}`);
                break;
            }
        }
    }
    console.log('...all files ready');
}

async function generateContentWithSearchTool(
    ai: GoogleGenAI,
    model: string,
    parts: any[],
    isThinkingModel: boolean,
) {
    const contents: any[] = [
        {
            role: 'user',
            parts,
        },
    ];

    const functionDeclaration = {
        name: 'search_web',
        description: 'Web検索を実行して、最新の参考URLと要約を返します。',
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

    for (let step = 0; step < 4; step++) {
        const configObj: any = {
            toolConfig: {
                functionCallingConfig: {
                    mode: FunctionCallingConfigMode.AUTO,
                    allowedFunctionNames: ['search_web'],
                },
            },
            tools: [{ functionDeclarations: [functionDeclaration] }],
        };
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
            return response;
        }

        contents.push({
            role: 'model',
            parts: functionCalls.map((call: any) =>
                createPartFromFunctionCall(call.name, (call.args || {}) as Record<string, unknown>)
            ),
        });

        const functionResponseParts = [];
        for (const call of functionCalls) {
            if (call.name !== 'search_web') {
                functionResponseParts.push(
                    createPartFromFunctionResponse(call.id || '', call.name, {
                        error: `Unsupported function: ${call.name}`,
                    }),
                );
                continue;
            }

            const query = typeof call.args?.query === 'string' ? call.args.query.trim() : '';
            const limit =
                typeof call.args?.limit === 'number' && Number.isFinite(call.args.limit)
                    ? call.args.limit
                    : 5;

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
                functionResponseParts.push(
                    createPartFromFunctionResponse(call.id || '', call.name, {
                        output: {
                            query,
                            results,
                        },
                    }),
                );
            } catch (error) {
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

/**
 * 議論を分析するメイン関数
 * @param audioFilesMap ユーザーID → MP3ファイルパスのマップ
 * @param contextHistory 前回の文脈
 * @param userMap ユーザーID → 表示名のマップ
 * @param apiKey APIキー（オプション、設定されていない場合は環境変数を使用）
 * @param mode 分析モード（"debate" | "summary"）
 */
export async function analyzeDiscussion(
    audioFilesMap: Map<string, string>,
    contextHistory: string = '',
    userMap: Map<string, string> | null = null,
    apiKey: string | null = null,
    mode: string = 'debate',
    modelName: string | null = null
): Promise<string> {
    // APIキーの決定
    const useKey = apiKey || GEMINI_API_KEY;
    if (!useKey) {
        return '❌ APIキーが設定されていません。`/settings set_key` で設定してください。';
    }

    // クライアント初期化
    let ai: GoogleGenAI;
    try {
        ai = new GoogleGenAI({ apiKey: useKey });
    } catch (e) {
        return `❌ APIクライアントの初期化に失敗しました: ${e}`;
    }

    const uploadedFiles: any[] = [];

    // プロンプト決定
    const systemPrompt = PROMPTS[mode] || PROMPTS['debate'];

    // コンテンツ構築
    const parts: any[] = [];

    // システムプロンプト
    parts.push({ text: systemPrompt });

    // 前回の文脈
    if (contextHistory) {
        parts.push({
            text: `前回の文脈:\n${contextHistory}\n---\n今回の議論:`,
        });
    }

    // 音声ファイルをアップロードして追加
    parts.push({
        text: `今回の参加者一覧:\n${Array.from(audioFilesMap.keys()).map((userId, index) => {
            const userName = userMap?.get(userId) || `User_${userId}`;
            return `${index + 1}. ${userName} [ID:${userId}]`;
        }).join('\n')}`,
    });

    for (const [userId, filePath] of audioFilesMap.entries()) {
        if (!fs.existsSync(filePath)) continue;

        const userName = userMap?.get(userId) || `User_${userId}`;

        try {
            const uploadedFile = await uploadToGemini(ai, filePath);
            uploadedFiles.push(uploadedFile);

            parts.push({ text: `発言者ラベル: ${userName} [ID:${userId}]` });
            parts.push({
                fileData: {
                    fileUri: uploadedFile.uri,
                    mimeType: uploadedFile.mimeType,
                },
            });
        } catch (e) {
            console.error(`Skipping file ${filePath} due to upload error: ${e}`);
        }
    }

    if (uploadedFiles.length === 0) {
        return '音声データがありませんでした（アップロード失敗またはファイルなし）。';
    }

    try {
        await waitForFilesActive(ai, uploadedFiles);

        // Gemini APIで分析実行（検索は function calling で付与）
        const useModel = modelName || GEMINI_MODEL_FLASH;
        console.log(`[Analyzer] 使用モデル: ${useModel}`);

        const isThinkingModel = useModel.includes('gemini-3.0') || useModel.includes('gemini-3.1');

        try {
            const response = await generateContentWithSearchTool(
                ai,
                useModel,
                parts,
                isThinkingModel,
            );

            // クリーンアップ
            for (const f of uploadedFiles) await ai.files.delete({ name: f.name }).catch(() => { });
            return appendReferenceUrls(response.text || '分析結果が空でした。', response);

        } catch (e: any) {
            throw e;
        }

    } catch (e: any) {
        // アップロードしたファイルをクリーンアップ（念のため）
        for (const f of uploadedFiles) {
            try {
                await ai.files.delete({ name: f.name });
            } catch {
                // ignore cleanup errors
            }
        }

        console.error(`Analysis Error: ${e}`);
        const errStr = String(e);
        if (errStr.includes('429') || errStr.includes('Quota exceeded')) {
            return '⚠️ 検索付き分析のリクエスト制限（Quota Limit）に達しました。';
        }
        return `分析中にエラーが発生しました: ${e}`;
    }
}
