import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, GEMINI_MODEL_FLASH } from '../config';
import { generateContentWithWebSearch } from '../geminiWebSearch';
import {
    ARTICLE_GENERATION_PROMPT,
    TOPIC_EXTRACTION_FALLBACK_PROMPT,
    TOPIC_EXTRACTION_PROMPT,
} from './prompts';
import { StoredAudioClip } from './storage';
import { ArticleTopic, TextChatEntry, TopicExtractionResult } from './types';

const FILE_UPLOAD_TIMEOUT_MS = 90_000;
const FILE_PROCESSING_TIMEOUT_MS = 180_000;
const FILE_STATUS_REQUEST_TIMEOUT_MS = 30_000;
const TOPIC_EXTRACTION_TIMEOUT_MS = 180_000;
const TOPIC_EXTRACTION_FALLBACK_TIMEOUT_MS = 90_000;

export type ArticleProgressReporter = (message: string) => Promise<void> | void;

// Gemini が ```json``` 付きで返しても JSON として読めるようにする。
function stripCodeFence(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    return text.trim();
}

// モデル出力を Bot 内部の型に寄せて、欠損値や余分な件数をならす。
function toJsonResult(rawText: string): TopicExtractionResult {
    const parsed = JSON.parse(stripCodeFence(rawText)) as Partial<TopicExtractionResult>;
    const topics = Array.isArray(parsed.topics) ? parsed.topics : [];

    return {
        sessionSummary: typeof parsed.sessionSummary === 'string' ? parsed.sessionSummary : '',
        topics: topics
            .map((topic, index) => ({
                id: typeof topic?.id === 'number' ? topic.id : index + 1,
                title: typeof topic?.title === 'string' ? topic.title : `トピック ${index + 1}`,
                summary: typeof topic?.summary === 'string' ? topic.summary : '',
                reason: typeof topic?.reason === 'string' ? topic.reason : '',
                speakers: Array.isArray(topic?.speakers)
                    ? topic.speakers.filter((speaker): speaker is string => typeof speaker === 'string')
                    : [],
                includesTextChat: Boolean(topic?.includesTextChat),
            }))
            .slice(0, 5),
    };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label}がタイムアウトしました。`));
        }, timeoutMs);
        timer.unref?.();

        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

async function reportProgress(
    onProgress: ArticleProgressReporter | undefined,
    message: string,
): Promise<void> {
    if (!onProgress) return;

    try {
        await onProgress(message);
    } catch {
        // ignore progress update failures
    }
}

function normalizeTopicExtractionError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);

    if (/timeout|timed out/i.test(message)) {
        return new Error('記事候補の抽出がタイムアウトしました。時間を置いて再試行してください。');
    }
    if (/UNAVAILABLE|high demand/i.test(message)) {
        return new Error('Gemini の混雑により記事候補を抽出できませんでした。少し時間を置いて再試行してください。');
    }
    if (/PERMISSION_DENIED|denied access/i.test(message)) {
        return new Error('Gemini API の権限で記事候補を抽出できませんでした。API キー設定を確認してください。');
    }

    return error instanceof Error ? error : new Error(message);
}

function shouldRetryTopicExtraction(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|UNAVAILABLE|high demand|search_web が呼ばれませんでした/i.test(message);
}

function isThinkingModel(modelName: string): boolean {
    return modelName.includes('gemini-3.0') || modelName.includes('gemini-3.1');
}

async function uploadToGemini(
    ai: GoogleGenAI,
    filePath: string,
    mimeType: string = 'audio/mp3',
) {
    return withTimeout(
        ai.files.upload({
            file: filePath,
            config: { mimeType },
        }),
        FILE_UPLOAD_TIMEOUT_MS,
        '音声ファイルのアップロード',
    );
}

async function waitForFilesActive(
    ai: GoogleGenAI,
    files: any[],
    onProgress?: ArticleProgressReporter,
): Promise<void> {
    for (const [index, fileRef] of files.entries()) {
        const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
        await reportProgress(
            onProgress,
            `⏳ 音声ファイルを処理しています... (${index + 1}/${files.length})`,
        );

        while (true) {
            const currentFile = await withTimeout(
                ai.files.get({ name: fileRef.name }),
                FILE_STATUS_REQUEST_TIMEOUT_MS,
                `音声ファイル ${index + 1}/${files.length} の状態確認`,
            );
            if (currentFile.state === 'ACTIVE') break;
            if (currentFile.state === 'FAILED') {
                throw new Error(`File processing failed: ${currentFile.name}`);
            }
            if (Date.now() >= deadline) {
                throw new Error(`音声ファイル ${index + 1}/${files.length} の処理がタイムアウトしました。`);
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

function createAiClient(apiKey: string | null): GoogleGenAI {
    const useKey = apiKey || GEMINI_API_KEY;
    if (!useKey) {
        throw new Error('Gemini APIキーが設定されていません。`/settings set_apikey` を実行してください。');
    }
    return new GoogleGenAI({ apiKey: useKey });
}

function buildParticipantMap(audioClips: StoredAudioClip[]): Map<string, string> {
    const participantMap = new Map<string, string>();
    for (const clip of audioClips) {
        if (!participantMap.has(clip.userId)) {
            participantMap.set(clip.userId, clip.displayName);
        }
    }
    return participantMap;
}

function buildSharedParts(
    audioClips: StoredAudioClip[],
    textEntries: TextChatEntry[],
): any[] {
    const parts: any[] = [];
    const participantMap = buildParticipantMap(audioClips);

    // 音声断片だけでは誰の声か崩れやすいので、最初に参加者一覧を固定情報として渡す。
    parts.push({
        text: `参加者一覧:\n${Array.from(participantMap.entries()).map(([userId, name], index) => {
            return `${index + 1}. ${name} [ID:${userId}]`;
        }).join('\n')}`,
    });

    // 同じテキストチャンネルの発言も、記事化の補助情報として AI に渡す。
    if (textEntries.length > 0) {
        parts.push({
            text: [
                '関連テキストチャット:',
                ...textEntries.map((entry) => `[${entry.timestamp}] ${entry.authorName}: ${entry.content}`),
            ].join('\n'),
        });
    } else {
        parts.push({ text: '関連テキストチャット: なし' });
    }

    return parts;
}

async function uploadAudioParts(
    ai: GoogleGenAI,
    audioClips: StoredAudioClip[],
    onProgress?: ArticleProgressReporter,
): Promise<{ uploadedFiles: any[]; audioParts: any[] }> {
    const uploadedFiles: any[] = [];
    const audioParts: any[] = [];

    try {
        for (const [index, clip] of audioClips.entries()) {
            const { userId, displayName, filePath, clipId } = clip;
            if (!fs.existsSync(filePath)) continue;

            await reportProgress(
                onProgress,
                `⏫ 音声ファイルをアップロードしています... (${index + 1}/${audioClips.length})`,
            );

            const uploadedFile = await uploadToGemini(ai, filePath);
            uploadedFiles.push(uploadedFile);

            // 各音声ファイルの直前に話者ラベルを置いて、誰の発言かを対応づける。
            audioParts.push({ text: `発言者ラベル: ${displayName} [ID:${userId}] / 断片ID: ${clipId}` });
            audioParts.push({
                fileData: {
                    fileUri: uploadedFile.uri,
                    mimeType: uploadedFile.mimeType,
                },
            });
        }
    } catch (error) {
        await cleanupUploads(ai, uploadedFiles);
        throw error;
    }

    return { uploadedFiles, audioParts };
}

async function cleanupUploads(ai: GoogleGenAI, uploadedFiles: any[]): Promise<void> {
    await Promise.all(
        uploadedFiles.map((fileRef) =>
            ai.files.delete({ name: fileRef.name }).catch(() => undefined),
        ),
    );
}

async function generateTopicExtractionResult(
    ai: GoogleGenAI,
    useModel: string,
    audioClips: StoredAudioClip[],
    textEntries: TextChatEntry[],
    onProgress: ArticleProgressReporter | undefined,
    options: {
        prompt: string;
        timeoutMs: number;
        useWebSearch: boolean;
    },
): Promise<TopicExtractionResult> {
    const { uploadedFiles, audioParts } = await uploadAudioParts(ai, audioClips, onProgress);

    if (uploadedFiles.length === 0) {
        return { sessionSummary: '音声ファイルの準備に失敗しました。', topics: [] };
    }

    try {
        await waitForFilesActive(ai, uploadedFiles, onProgress);

        if (options.useWebSearch) {
            await reportProgress(onProgress, '🔎 Web 検索を使いながら記事候補を抽出しています...');
            const { response } = await withTimeout(
                generateContentWithWebSearch(
                    ai,
                    useModel,
                    [
                        { text: options.prompt },
                        ...buildSharedParts(audioClips, textEntries),
                        ...audioParts,
                    ],
                    {
                        responseMimeType: 'application/json',
                        isThinkingModel: isThinkingModel(useModel),
                        forceSearch: true,
                    },
                ),
                options.timeoutMs,
                '記事候補の抽出',
            );
            return toJsonResult(response.text || '{"sessionSummary":"","topics":[]}');
        }

        await reportProgress(onProgress, '🧠 軽量モードで記事候補を再抽出しています...');
        const response = await withTimeout(
            ai.models.generateContent({
                model: useModel,
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: options.prompt },
                            ...buildSharedParts(audioClips, textEntries),
                            ...audioParts,
                        ],
                    },
                ],
                config: {
                    responseMimeType: 'application/json',
                    ...(isThinkingModel(useModel)
                        ? {
                            thinkingConfig: {
                                thinkingLevel: 'HIGH' as any,
                            },
                        }
                        : {}),
                } as any,
            }),
            options.timeoutMs,
            '軽量モードでの記事候補抽出',
        );
        return toJsonResult(response.text || '{"sessionSummary":"","topics":[]}');
    } finally {
        await cleanupUploads(ai, uploadedFiles);
    }
}

export async function extractArticleTopics(
    audioClips: StoredAudioClip[],
    textEntries: TextChatEntry[],
    apiKey: string | null,
    modelName: string | null,
    onProgress?: ArticleProgressReporter,
): Promise<TopicExtractionResult> {
    if (audioClips.length === 0) {
        return { sessionSummary: '録音データがありませんでした。', topics: [] };
    }

    const ai = createAiClient(apiKey);
    const useModel = modelName || GEMINI_MODEL_FLASH;
    let lastResult: TopicExtractionResult | null = null;

    try {
        const primaryResult = await generateTopicExtractionResult(
            ai,
            useModel,
            audioClips,
            textEntries,
            onProgress,
            {
                prompt: TOPIC_EXTRACTION_PROMPT,
                timeoutMs: TOPIC_EXTRACTION_TIMEOUT_MS,
                useWebSearch: true,
            },
        );
        if (primaryResult.topics.length > 0) {
            return primaryResult;
        }

        lastResult = primaryResult;
        await reportProgress(
            onProgress,
            '🔁 候補が見つからなかったため、軽量モードで候補を再抽出しています...',
        );
    } catch (error) {
        if (!shouldRetryTopicExtraction(error)) {
            throw normalizeTopicExtractionError(error);
        }

        await reportProgress(
            onProgress,
            '🔁 抽出に時間がかかっているため、軽量モードで候補を再抽出しています...',
        );
    }

    try {
        return await generateTopicExtractionResult(
            ai,
            useModel,
            audioClips,
            textEntries,
            onProgress,
            {
                prompt: TOPIC_EXTRACTION_FALLBACK_PROMPT,
                timeoutMs: TOPIC_EXTRACTION_FALLBACK_TIMEOUT_MS,
                useWebSearch: false,
            },
        );
    } catch (error) {
        if (lastResult) {
            return lastResult;
        }
        throw normalizeTopicExtractionError(error);
    }
}

export async function generateArticleFromTopic(
    audioClips: StoredAudioClip[],
    textEntries: TextChatEntry[],
    topic: ArticleTopic,
    apiKey: string | null,
    modelName: string | null,
): Promise<string> {
    if (audioClips.length === 0) {
        return '記事生成に必要な音声データがありません。';
    }

    const ai = createAiClient(apiKey);
    const useModel = modelName || GEMINI_MODEL_FLASH;
    const { uploadedFiles, audioParts } = await uploadAudioParts(ai, audioClips);

    if (uploadedFiles.length === 0) {
        return '記事生成に必要な音声ファイルの準備に失敗しました。';
    }

    try {
        await waitForFilesActive(ai, uploadedFiles);

        // 記事生成では、選ばれたトピック情報を追加して本文だけを返させる。
        const { response } = await generateContentWithWebSearch(
            ai,
            useModel,
            [
                { text: ARTICLE_GENERATION_PROMPT },
                {
                    text: `選択されたトピック:\n${JSON.stringify(topic, null, 2)}`,
                },
                ...buildSharedParts(audioClips, textEntries),
                ...audioParts,
            ],
            {
                isThinkingModel: isThinkingModel(useModel),
                forceSearch: true,
            },
        );

        return response.text || '記事を生成できませんでした。';
    } finally {
        await cleanupUploads(ai, uploadedFiles);
    }
}
