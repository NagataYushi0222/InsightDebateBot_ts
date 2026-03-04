import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import fs from 'fs';
import { GEMINI_API_KEY, GEMINI_MODEL_FLASH } from './config';

/**
 * 分析プロンプト定義
 */
const PROMPTS: Record<string, string> = {
    debate: `
あなたはプロの議論アナリスト兼ファクトチェッカーです。提供された複数の音声ファイル（各ファイル名にユーザーIDまたは名前が含まれる）を分析し、以下の形式でレポートを作成してください。

分析ルール:
1. 各ファイルの声とユーザー名を正確に紐付けてください。
2. **Grounding (Google検索) は必須です**。議論の中で出た事実（例：「現在の失業率は〜」「〇〇というニュースがあった」）について、必ず検索機能を使用して最新情報を確認してください。
3. 以前の発言と矛盾している点があれば指摘してください。

出力項目:
【議論の要約】: (300字以内)
【各ユーザーの立場】: (ユーザー名: 賛成/反対/中立などの属性と主要な意見)
【現在の対立構造】: (何がボトルネックで合意に至っていないか)
【争点と矛盾・ファクトチェック】: (発言の矛盾点や、最新のネット情報と照らし合わせた誤りの指摘)
【対立点の折衷案】: (対立点を解決するための折衷案の提案)
`,
    summary: `
あなたは会議の書記です。提供された音声ファイルを分析し、途中から参加した人でも状況がわかるような親切な要約を作成してください。

分析ルール:
1. 誰が何について話しているかを明確にしてください。
2. 専門用語や文脈依存の単語には簡単な補足を加えてください。

出力項目:
【現在のトピック】: (今何を話しているか、数行でシンプルに)
【これまでの流れ】: (時系列で主な発言と決定事項を箇条書き)
【未解決の課題】: (まだ決まっていないこと、次に話すべきこと)
【参加者の発言要旨】: (各参加者の主な主張)
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
    for (const [userId, filePath] of audioFilesMap.entries()) {
        if (!fs.existsSync(filePath)) continue;

        const userName = userMap?.get(userId) || `User_${userId}`;

        try {
            const uploadedFile = await uploadToGemini(ai, filePath);
            uploadedFiles.push(uploadedFile);

            parts.push({ text: `発言者: ${userName}` });
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

        // Gemini APIで分析実行（まずはツールありで試行）
        const useModel = modelName || GEMINI_MODEL_FLASH;
        console.log(`[Analyzer] 使用モデル: ${useModel}`);

        try {
            const response = await ai.models.generateContent({
                model: useModel,
                contents: [
                    {
                        role: 'user',
                        parts,
                    },
                ],
                config: {
                    tools: [
                        { googleSearch: {} },
                    ],
                    thinkingConfig: {
                        thinkingLevel: 'HIGH' as any,
                    },
                },
            });

            // クリーンアップ
            for (const f of uploadedFiles) await ai.files.delete({ name: f.name }).catch(() => { });
            return response.text || '分析結果が空でした。';

        } catch (e: any) {
            const errStr = String(e);

            // 429エラーの場合、ツールなしでリトライ
            if (errStr.includes('429') || errStr.includes('Quota exceeded') || errStr.includes('RESOURCE_EXHAUSTED')) {
                console.warn('Rate limited. Retrying without Google Search...');
                try {
                    const responseRetry = await ai.models.generateContent({
                        model: useModel,
                        contents: [
                            {
                                role: 'user',
                                parts,
                            },
                        ],
                        config: {
                            thinkingConfig: {
                                thinkingLevel: 'HIGH' as any,
                            },
                        },
                    });

                    // クリーンアップ
                    for (const f of uploadedFiles) await ai.files.delete({ name: f.name }).catch(() => { });
                    return (responseRetry.text || '分析結果が空でした。') + '\n\n(※ リクエスト制限のため、Google検索なしで生成しました)';
                } catch (retryErr) {
                    throw retryErr; // リトライも失敗したら投げる
                }
            }
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
            return '⚠️ 分析のリクエスト制限（Quota Limit）に達しました。Google検索の使用が制限されている可能性があります。時間を置いて試してください。';
        }
        return `分析中にエラーが発生しました: ${e}`;
    }
}
