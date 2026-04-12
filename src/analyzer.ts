import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import { GEMINI_API_KEY, GEMINI_MODEL_FLASH } from './config';
import {
    generateContentWithWebSearch,
    SearchTrace,
} from './geminiWebSearch';

interface SearchReferenceEntry {
    refId: string;
    title: string;
    url: string;
    query: string;
    snippet: string;
}

function buildSearchReferenceEntries(searchTrace: SearchTrace[]): SearchReferenceEntry[] {
    const seenReferenceIds = new Set<string>();
    const references: SearchReferenceEntry[] = [];

    for (const trace of searchTrace) {
        for (const result of trace.results) {
            if (!result.url || seenReferenceIds.has(result.referenceId)) {
                continue;
            }

            seenReferenceIds.add(result.referenceId);
            references.push({
                refId: result.referenceId,
                title: result.title,
                url: result.url,
                query: trace.query,
                snippet: result.snippet,
            });
        }
    }

    return references;
}

function stripReferenceSection(reportText: string): string {
    return reportText.replace(/\n*【参考URL】[\s\S]*$/, '').trimEnd();
}

function buildReferenceSection(
    references: SearchReferenceEntry[],
    allReferenceCount: number,
): string {
    if (references.length === 0) {
        if (allReferenceCount === 0) {
            return '【参考URL】\n- 検索結果から有効なURLを取得できませんでした。';
        }

        return '【参考URL】\n- 本文中で参考番号が引用されなかったため、実際に参照したURLを特定できませんでした。';
    }

    return [
        '【参考URL】',
        ...references.map((reference) => `[${reference.refId}] ${reference.title}\n${reference.url}`),
    ].join('\n');
}

function extractReferencedIds(reportText: string): Set<string> {
    const ids = new Set<string>();
    const matches = reportText.matchAll(/\[(参考\d+)\]/g);

    for (const match of matches) {
        const refId = match[1];
        if (refId) {
            ids.add(refId);
        }
    }

    return ids;
}

function selectUsedReferences(
    reportText: string,
    references: SearchReferenceEntry[],
): SearchReferenceEntry[] {
    const referencedIds = extractReferencedIds(reportText);
    if (referencedIds.size === 0) {
        return [];
    }

    return references.filter((reference) => referencedIds.has(reference.refId));
}

function buildFactCheckFallbackSection(mode: string, references: SearchReferenceEntry[]): string {
    const sectionTitle = mode === 'summary'
        ? '【ファクトチェック】'
        : '【争点と矛盾・ファクトチェック】';

    if (references.length === 0) {
        return `${sectionTitle}\n- 検索結果を取得できなかったため、根拠URL付きのファクトチェックは付与できませんでした。`;
    }

    const grouped = new Map<string, SearchReferenceEntry[]>();
    for (const reference of references) {
        const current = grouped.get(reference.query) || [];
        current.push(reference);
        grouped.set(reference.query, current);
    }

    const lines = [sectionTitle];

    for (const [query, queryReferences] of grouped.entries()) {
        const topReferences = queryReferences.slice(0, 2);
        lines.push(`- 確認観点: ${query}`);
        lines.push(`  - 参照: ${topReferences.map((reference) => `[${reference.refId}]`).join(', ')}`);

        const snippet = topReferences
            .map((reference) => reference.snippet)
            .find((value) => value && value.length > 0);

        if (snippet) {
            lines.push(`  - 検索メモ: ${snippet}`);
        }
    }

    return lines.join('\n');
}

function ensureFactCheckSection(
    reportText: string,
    mode: string,
    references: SearchReferenceEntry[],
): string {
    const hasSummaryFactCheck = /【ファクトチェック】/.test(reportText);
    const hasDebateFactCheck = /【争点と矛盾・ファクトチェック】/.test(reportText);

    if ((mode === 'summary' && hasSummaryFactCheck) || (mode !== 'summary' && hasDebateFactCheck)) {
        return reportText;
    }

    const fallbackSection = buildFactCheckFallbackSection(mode, references);
    return `${reportText.trimEnd()}\n\n${fallbackSection}`;
}

function appendReferenceUrls(reportText: string, mode: string, searchTrace: SearchTrace[]): string {
    const references = buildSearchReferenceEntries(searchTrace);
    const factCheckedReport = ensureFactCheckSection(
        stripReferenceSection(reportText),
        mode,
        references,
    );
    const usedReferences = selectUsedReferences(factCheckedReport, references);
    const referenceSection = buildReferenceSection(usedReferences, references.length);
    return `${factCheckedReport}\n\n${referenceSection}`;
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
7. **検索結果に含まれていないURLを推測で書いてはいけません。URLの創作は禁止です。本文中に生URLを捏造せず、根拠は末尾の【参考URL】欄に載る実在URLだけを前提にしてください。**
8. **検索結果を使った主張・制度説明・数値確認・ニュース確認には、必ず対応する参照番号（例: [参考1]）を本文に付けてください。参照番号が付いていない主張は根拠なしと見なされます。**

出力項目:
【議論の要約】: (300字以内)
【各ユーザーの立場】: (ユーザー名: 賛成/反対/中立などの属性と主要な意見)
【現在の対立構造】: (何がボトルネックで合意に至っていないか)
【争点と矛盾・ファクトチェック】: (発言の矛盾点や、最新のネット情報と照らし合わせた誤りの指摘。各項目で「確認内容」「確認結果」「参照した参考番号([参考1]など)」を明記)
【対立点の折衷案】: (対立点を解決するための折衷案の提案)
【参考URL】: (Web検索で参照したURLを番号付きで列挙。形式は「[参考N] タイトル」の次の行にURL。本文ではこの番号を使って参照)

**前置き・挨拶・自己紹介は一切不要です。上記の出力項目のみをそのまま出力してください。**
`,
    summary: `
あなたは会議の書記です。提供された音声ファイルを分析し、途中から参加した人でも状況がわかるような親切な要約を作成してください。

分析ルール:
1. 誰が何について話しているかを明確にしてください。
1.5. **各音声ファイルの直前に書かれた「発言者ラベル」が、そのファイルの唯一の話者です。別ファイルの発言をその人に混ぜないでください。話者が確信できない内容は「不明」としてください。**
2. 専門用語や文脈依存の単語には簡単な補足を加えてください。
3. **提供された Web 検索機能を必ず 1 回以上使ってください**。時事情報、制度、製品、固有名詞、数値、ニュース性のある話題は検索で確認してください。
4. **【重要】音声が無音、ノイズのみ、または意味のある会話が含まれていない場合は、無理に分析せず、「特に新しい議論はありませんでした。」とだけ出力してください。**
5. 「前回の文脈」はあくまで参考情報です。**今回提供された音声ファイルに含まれていない発言を、前回の文脈から捏造してレポートに含めないでください。**
6. **ある参加者の発言を別の参加者に割り当てることは禁止です。**
7. **検索結果に含まれていないURLを推測で書いてはいけません。URLの創作は禁止です。本文中に生URLを捏造せず、根拠は末尾の【参考URL】欄に載る実在URLだけを前提にしてください。**
8. **検索結果を使った主張・制度説明・数値確認・ニュース確認には、必ず対応する参照番号（例: [参考1]）を本文に付けてください。参照番号が付いていない主張は根拠なしと見なされます。**

出力項目:
【現在のトピック】: (今何を話しているか、数行でシンプルに)
【これまでの流れ】: (時系列で主な発言と決定事項を箇条書き)
【未解決の課題】: (まだ決まっていないこと、次に話すべきこと)
【参加者の発言要旨】: (各参加者の主な主張)
【ファクトチェック】: (制度・数値・固有名詞・ニュース性のある話題について確認した内容を箇条書きで記載。各項目で「確認内容」「確認結果」「参照した参考番号([参考1]など)」を明記)
【参考URL】: (Web検索で参照したURLを番号付きで列挙。形式は「[参考N] タイトル」の次の行にURL。本文ではこの番号を使って参照)

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
            const { response, searchTrace } = await generateContentWithWebSearch(
                ai,
                useModel,
                parts,
                {
                    isThinkingModel,
                    forceSearch: true,
                },
            );

            // クリーンアップ
            for (const f of uploadedFiles) await ai.files.delete({ name: f.name }).catch(() => { });
            return appendReferenceUrls(
                response.text || '分析結果が空でした。',
                mode,
                searchTrace,
            );

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
