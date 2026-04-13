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
    sourceExcerpt: string;
}

export interface StructuredParticipantMemory {
    displayName: string;
    userId: string | null;
    stance: string;
    keyPoints: string[];
}

export interface StructuredFactMemory {
    topic: string;
    status: 'confirmed' | 'disputed' | 'uncertain';
    summary: string;
    referenceIds: string[];
}

export interface StructuredDiscussionMemory {
    version: 1;
    mode: string;
    dialogueTheme: string | null;
    currentTopic: string;
    carryForwardSummary: string;
    progressSincePrevious: string[];
    participantStates: StructuredParticipantMemory[];
    agreements: string[];
    unresolvedQuestions: string[];
    factChecks: StructuredFactMemory[];
    nextFocus: string[];
}

export interface AnalyzeDiscussionResult {
    report: string;
    memory: StructuredDiscussionMemory | null;
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
                sourceExcerpt: result.sourceExcerpt || '',
            });
        }
    }

    return references;
}

function stripReferenceSection(reportText: string): string {
    return reportText.replace(/\n*【参考URL】[\s\S]*$/, '').trimEnd();
}

function sanitizeReferenceMentions(
    reportText: string,
    references: SearchReferenceEntry[],
): string {
    const availableReferenceIds = new Set(references.map((reference) => reference.refId));

    let sanitized = reportText.replace(/\[(参考\d+)\]/g, (match, refId: string) => (
        availableReferenceIds.has(refId) ? match : ''
    ));

    if (references.length === 0) {
        // 検索結果が 0 件のときは、モデルが勝手に書いた参照番号を残さない。
        sanitized = sanitized
            .replace(/(参照(?:した)?(?:参考)?番号[^:\n]*[:：])\s*[^\n]+/g, '$1 なし')
            .replace(/(対応する参考番号[^:\n]*[:：])\s*[^\n]+/g, '$1 なし');
    }

    return sanitized
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

function stripCodeFence(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }
    return text.trim();
}

function trimMemoryText(text: unknown, maxLength: number): string {
    if (typeof text !== 'string') {
        return '';
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => trimMemoryText(item, maxLength))
        .filter(Boolean)
        .slice(0, maxItems);
}

function sanitizeStructuredMemory(
    raw: Partial<StructuredDiscussionMemory> | null | undefined,
    mode: string,
    dialogueTheme: string | null,
): StructuredDiscussionMemory {
    const participantStates = Array.isArray(raw?.participantStates)
        ? raw!.participantStates
            .map((participant) => ({
                displayName: trimMemoryText(participant?.displayName, 60) || '不明',
                userId: typeof participant?.userId === 'string'
                    ? trimMemoryText(participant.userId, 60) || null
                    : null,
                stance: trimMemoryText(participant?.stance, 120) || '未整理',
                keyPoints: sanitizeStringArray(participant?.keyPoints, 4, 180),
            }))
            .slice(0, 8)
        : [];

    const factChecks = Array.isArray(raw?.factChecks)
        ? raw!.factChecks
            .map((factCheck) => ({
                topic: trimMemoryText(factCheck?.topic, 160),
                status: factCheck?.status === 'confirmed' || factCheck?.status === 'disputed'
                    ? factCheck.status
                    : 'uncertain' as const,
                summary: trimMemoryText(factCheck?.summary, 220),
                referenceIds: sanitizeStringArray(factCheck?.referenceIds, 4, 20),
            }))
            .filter((factCheck) => factCheck.topic.length > 0)
            .slice(0, 8)
        : [];

    return {
        version: 1,
        mode,
        dialogueTheme: trimMemoryText(raw?.dialogueTheme, 200) || dialogueTheme || null,
        currentTopic: trimMemoryText(raw?.currentTopic, 200),
        carryForwardSummary: trimMemoryText(raw?.carryForwardSummary, 400),
        progressSincePrevious: sanitizeStringArray(raw?.progressSincePrevious, 6, 220),
        participantStates,
        agreements: sanitizeStringArray(raw?.agreements, 6, 180),
        unresolvedQuestions: sanitizeStringArray(raw?.unresolvedQuestions, 6, 180),
        factChecks,
        nextFocus: sanitizeStringArray(raw?.nextFocus, 6, 180),
    };
}

function formatMemoryForPrompt(memory: StructuredDiscussionMemory | null): string {
    if (!memory) {
        return '前回の構造化メモ: なし';
    }

    return [
        '前回の構造化メモ(JSON):',
        JSON.stringify(memory, null, 2),
    ].join('\n');
}

function getFactCheckSectionTitle(mode: string): string {
    return mode === 'debate' ? '【争点と矛盾・ファクトチェック】' : '【ファクトチェック】';
}

function buildReferenceSection(
    citedReferences: SearchReferenceEntry[],
    consultedReferences: SearchReferenceEntry[],
    allReferenceCount: number,
): string {
    if (citedReferences.length > 0) {
        return [
            '【参考URL】',
            ...citedReferences.map((reference) => `[${reference.refId}] ${reference.title}\n${reference.url}`),
        ].join('\n');
    }

    if (consultedReferences.length === 0) {
        if (allReferenceCount === 0) {
            return '【参考URL】\n- 検索結果から有効なURLを取得できませんでした。';
        }
        return '【参考URL】\n- 検索は実行されましたが、有効な参考URLを組み立てられませんでした。';
    }

    return [
        '【参考URL】',
        '- 本文中で参考番号の明示がなかったため、以下には今回の検索で実際に取得してモデルへ渡したURLを掲載します。',
        ...consultedReferences.map((reference) => `[${reference.refId}] ${reference.title}\n${reference.url}`),
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
    const sectionTitle = getFactCheckSectionTitle(mode);

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

        const sourceMemo = topReferences
            .map((reference) => reference.sourceExcerpt || reference.snippet)
            .find((value) => value && value.length > 0);

        if (sourceMemo) {
            lines.push(`  - ソース抜粋: ${sourceMemo}`);
        }
    }

    return lines.join('\n');
}

function ensureFactCheckSection(
    reportText: string,
    mode: string,
    references: SearchReferenceEntry[],
): string {
    const sectionTitle = getFactCheckSectionTitle(mode);
    if (reportText.includes(sectionTitle)) {
        return reportText;
    }

    const fallbackSection = buildFactCheckFallbackSection(mode, references);
    return `${reportText.trimEnd()}\n\n${fallbackSection}`;
}

function addFactCheckReferenceHint(
    reportText: string,
    mode: string,
    references: SearchReferenceEntry[],
): string {
    if (references.length === 0) {
        return reportText;
    }

    const sectionTitle = getFactCheckSectionTitle(mode);
    const sectionStart = reportText.indexOf(sectionTitle);
    if (sectionStart === -1) {
        return reportText;
    }

    const nextSectionIndex = reportText.indexOf('\n【', sectionStart + sectionTitle.length);
    const sectionEnd = nextSectionIndex === -1 ? reportText.length : nextSectionIndex;
    const sectionBody = reportText.slice(sectionStart, sectionEnd);
    if (/\[(参考\d+)\]/.test(sectionBody)) {
        return reportText;
    }

    const hintedRefs = references
        .slice(0, 3)
        .map((reference) => `[${reference.refId}]`)
        .join(', ');
    const hintLines = [
        '- 補足:',
        `  - モデル本文では参照番号が明示されませんでしたが、今回の検索で取得してモデルへ渡した候補は ${hintedRefs} です。`,
        '  - 対応するURLは末尾の【参考URL】を参照してください。',
    ].join('\n');

    return `${reportText.slice(0, sectionEnd).trimEnd()}\n${hintLines}${reportText.slice(sectionEnd)}`;
}

function appendReferenceUrls(reportText: string, mode: string, searchTrace: SearchTrace[]): string {
    const references = buildSearchReferenceEntries(searchTrace);
    const sanitizedReport = sanitizeReferenceMentions(
        stripReferenceSection(reportText),
        references,
    );
    const factCheckedReport = ensureFactCheckSection(
        sanitizedReport,
        mode,
        references,
    );
    const hintedReport = sanitizeReferenceMentions(
        addFactCheckReferenceHint(factCheckedReport, mode, references),
        references,
    );
    const usedReferences = selectUsedReferences(hintedReport, references);
    const fallbackConsultedReferences = usedReferences.length > 0 ? [] : references.slice(0, 5);
    const referenceSection = buildReferenceSection(
        usedReferences,
        fallbackConsultedReferences,
        references.length,
    );
    return `${hintedReport}\n\n${referenceSection}`;
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
5. 「前回の構造化メモ」はあくまで参考情報です。**今回提供された音声ファイルに含まれていない発言を、前回メモから捏造してレポートに含めないでください。**
6. **ある参加者の発言を別の参加者に割り当てることは禁止です。**
7. **検索結果に含まれていないURLを推測で書いてはいけません。URLの創作は禁止です。本文中に生URLを捏造せず、根拠は末尾の【参考URL】欄に載る実在URLだけを前提にしてください。**
8. **検索結果を使った主張・制度説明・数値確認・ニュース確認には、必ず対応する参照番号（例: [参考1]）を本文に付けてください。参照番号が付いていない主張は根拠なしと見なされます。**
9. **検索結果には、検索エンジンの見出しだけでなく、実際にアクセスしたURL本文から抽出した sourceExcerpt が含まれます。ファクトチェックは snippet より sourceExcerpt を優先し、sourceExcerpt が空の結果では断定を避けてください。**

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
5. 「前回の構造化メモ」はあくまで参考情報です。**今回提供された音声ファイルに含まれていない発言を、前回メモから捏造してレポートに含めないでください。**
6. **ある参加者の発言を別の参加者に割り当てることは禁止です。**
7. **検索結果に含まれていないURLを推測で書いてはいけません。URLの創作は禁止です。本文中に生URLを捏造せず、根拠は末尾の【参考URL】欄に載る実在URLだけを前提にしてください。**
8. **検索結果を使った主張・制度説明・数値確認・ニュース確認には、必ず対応する参照番号（例: [参考1]）を本文に付けてください。参照番号が付いていない主張は根拠なしと見なされます。**
9. **検索結果には、検索エンジンの見出しだけでなく、実際にアクセスしたURL本文から抽出した sourceExcerpt が含まれます。ファクトチェックは snippet より sourceExcerpt を優先し、sourceExcerpt が空の結果では断定を避けてください。**

出力項目:
【現在のトピック】: (今何を話しているか、数行でシンプルに)
【これまでの流れ】: (時系列で主な発言と決定事項を箇条書き)
【未解決の課題】: (まだ決まっていないこと、次に話すべきこと)
【参加者の発言要旨】: (各参加者の主な主張)
【ファクトチェック】: (制度・数値・固有名詞・ニュース性のある話題について確認した内容を箇条書きで記載。各項目で「確認内容」「確認結果」「参照した参考番号([参考1]など)」を明記)
【参考URL】: (Web検索で参照したURLを番号付きで列挙。形式は「[参考N] タイトル」の次の行にURL。本文ではこの番号を使って参照)

**前置き・挨拶・自己紹介は一切不要です。上記の出力項目のみをそのまま出力してください。**
`,
    dialogue: `
あなたは、事前に決められたテーマに沿って Discord VC の対話内容を整理するファシリテーション記録係です。
提供された音声ファイルを分析し、「今回の対話テーマに対して、どんな言及・進展・論点が出たか」を中心にレポートしてください。

分析ルール:
1. 今回は「与えられた対話テーマ」が最優先です。雑談や脱線があっても、レポートではテーマに関係する言及を主眼に整理してください。
2. 各音声ファイルの直前に書かれた「発言者ラベル」が、そのファイルの唯一の話者です。別ファイルの発言をその人に混ぜないでください。
3. 音声にテーマ関連の言及がほとんどない場合は、そのことを明示してください。無理に話をつなげて捏造しないでください。
4. 提供された Web 検索機能を必ず 1 回以上使い、制度・数値・固有名詞・ニュース性のある主張は検索で確認してください。
5. 検索結果に含まれていないURLを推測で書いてはいけません。URLの創作は禁止です。本文中に生URLを捏造せず、根拠は末尾の【参考URL】欄に載る実在URLだけを前提にしてください。
6. 検索結果を使った主張・制度説明・数値確認・ニュース確認には、必ず対応する参照番号（例: [参考1]）を本文に付けてください。参照番号が付いていない主張は根拠なしと見なされます。
7. 検索結果には、検索エンジンの見出しだけでなく、実際にアクセスしたURL本文から抽出した sourceExcerpt が含まれます。ファクトチェックは snippet より sourceExcerpt を優先し、sourceExcerpt が空の結果では断定を避けてください。
8. 前回の構造化メモは参考情報です。今回の音声にない発言を補ってはいけません。

出力項目:
【対話テーマ】: (与えられたテーマをそのまま簡潔に再掲)
【今回テーマについて進んだこと】: (今回の会話でテーマに関して前進した点、整理された点)
【テーマについて出た主な意見】: (テーマに対して出た賛否・仮説・具体例を時系列がわかるように整理)
【まだ深掘りが必要な点】: (結論が出ていない点、次回持ち越しの論点)
【参加者ごとのテーマ言及】: (各参加者がテーマに関して何を述べたか)
【ファクトチェック】: (制度・数値・固有名詞・ニュース性のある話題について確認した内容を箇条書きで記載。各項目で「確認内容」「確認結果」「参照した参考番号([参考1]など)」を明記)
【参考URL】: (Web検索で参照したURLを番号付きで列挙。形式は「[参考N] タイトル」の次の行にURL。本文ではこの番号を使って参照)

**前置き・挨拶・自己紹介は一切不要です。上記の出力項目のみをそのまま出力してください。**
`,
};

const MEMORY_UPDATE_PROMPT = `
あなたは Discord VC セッションの継続状態を保存するための「構造化メモ更新器」です。
前回の構造化メモと今回の分析レポートを読み、次回の分析で使いやすい JSON メモを更新してください。

重要ルール:
1. 出力は JSON のみ。Markdown や説明文は不要です。
2. 今回レポートに書かれていない事実を補わないでください。
3. 前回メモの内容を引き継ぎつつ、今回のレポートで更新・上書きすべき点を反映してください。
4. 自然文の長い文章ではなく、次回の分析で参照しやすい短い要点にしてください。
5. 参照番号が付いていないファクトチェックは断定せず、status を "uncertain" に寄せてください。

JSON スキーマ:
{
  "version": 1,
  "mode": "debate | summary | dialogue",
  "dialogueTheme": "string | null",
  "currentTopic": "現在の中心トピック",
  "carryForwardSummary": "次回へ引き継ぐ短い全体要約",
  "progressSincePrevious": ["今回前進した点"],
  "participantStates": [
    {
      "displayName": "話者名",
      "userId": "Discord user id or null",
      "stance": "立場や役割の短い説明",
      "keyPoints": ["その人の重要発言"]
    }
  ],
  "agreements": ["合意したこと"],
  "unresolvedQuestions": ["未解決論点"],
  "factChecks": [
    {
      "topic": "確認対象",
      "status": "confirmed | disputed | uncertain",
      "summary": "次回に引き継ぐ短い結論",
      "referenceIds": ["参考1", "参考2"]
    }
  ],
  "nextFocus": ["次回この観点を深掘りするとよい"]
}
`;

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

async function generateStructuredMemory(
    ai: GoogleGenAI,
    modelName: string,
    reportText: string,
    previousMemory: StructuredDiscussionMemory | null,
    mode: string,
    dialogueTheme: string | null,
    isThinkingModel: boolean,
): Promise<StructuredDiscussionMemory | null> {
    try {
        const response = await ai.models.generateContent({
            model: modelName,
            contents: [{
                role: 'user',
                parts: [
                    { text: MEMORY_UPDATE_PROMPT },
                    { text: `今回の分析モード: ${mode}` },
                    { text: `今回の対話テーマ: ${dialogueTheme?.trim() || 'なし'}` },
                    { text: formatMemoryForPrompt(previousMemory) },
                    { text: `今回の分析レポート:\n${reportText}` },
                ],
            }],
            config: {
                responseMimeType: 'application/json',
                ...(isThinkingModel
                    ? { thinkingConfig: { thinkingLevel: 'HIGH' as any } }
                    : {}),
            },
        });

        const parsed = JSON.parse(stripCodeFence(response.text || '{}')) as Partial<StructuredDiscussionMemory>;
        return sanitizeStructuredMemory(parsed, mode, dialogueTheme);
    } catch (error) {
        console.error('[Analyzer] Structured memory generation failed:', error);
        return previousMemory ? sanitizeStructuredMemory(previousMemory, mode, dialogueTheme) : null;
    }
}

/**
 * 議論を分析するメイン関数
 * @param audioFilesMap ユーザーID → MP3ファイルパスのマップ
 * @param previousMemory 前回の構造化メモ
 * @param userMap ユーザーID → 表示名のマップ
 * @param apiKey APIキー（オプション、設定されていない場合は環境変数を使用）
 * @param mode 分析モード（"debate" | "summary"）
 */
export async function analyzeDiscussion(
    audioFilesMap: Map<string, string>,
    previousMemory: StructuredDiscussionMemory | null = null,
    userMap: Map<string, string> | null = null,
    apiKey: string | null = null,
    mode: string = 'debate',
    modelName: string | null = null,
    dialogueTheme: string | null = null,
): Promise<AnalyzeDiscussionResult> {
    // APIキーの決定
    const useKey = apiKey || GEMINI_API_KEY;
    if (!useKey) {
        return {
            report: '❌ APIキーが設定されていません。`/settings set_key` で設定してください。',
            memory: previousMemory,
        };
    }

    // クライアント初期化
    let ai: GoogleGenAI;
    try {
        ai = new GoogleGenAI({ apiKey: useKey });
    } catch (e) {
        return {
            report: `❌ APIクライアントの初期化に失敗しました: ${e}`,
            memory: previousMemory,
        };
    }

    const uploadedFiles: any[] = [];

    // プロンプト決定
    const systemPrompt = PROMPTS[mode] || PROMPTS['debate'];

    // コンテンツ構築
    const parts: any[] = [];

    // システムプロンプト
    parts.push({ text: systemPrompt });

    if (mode === 'dialogue') {
        parts.push({
            text: `今回の対話テーマ:\n${dialogueTheme?.trim() || '未指定'}\n---\nこのテーマへの言及を主眼に、今回の音声だけを整理してください。`,
        });
    }

    parts.push({
        text: `${formatMemoryForPrompt(previousMemory)}\n---\n今回の議論:`,
    });

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
        return {
            report: '音声データがありませんでした（アップロード失敗またはファイルなし）。',
            memory: previousMemory,
        };
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
            const report = appendReferenceUrls(
                response.text || '分析結果が空でした。',
                mode,
                searchTrace,
            );
            const memory = await generateStructuredMemory(
                ai,
                useModel,
                report,
                previousMemory,
                mode,
                dialogueTheme,
                isThinkingModel,
            );
            return {
                report,
                memory,
            };

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
            return {
                report: '⚠️ 検索付き分析のリクエスト制限（Quota Limit）に達しました。',
                memory: previousMemory,
            };
        }
        return {
            report: `分析中にエラーが発生しました: ${e}`,
            memory: previousMemory,
        };
    }
}
