import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, GEMINI_MODEL_FLASH } from '../config';
import { generateContentWithWebSearch } from '../geminiWebSearch';
import { ARTICLE_GENERATION_PROMPT, TOPIC_EXTRACTION_PROMPT } from './prompts';
import { StoredAudioClip } from './storage';
import { ArticleTopic, TextChatEntry, TopicExtractionResult } from './types';

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

async function uploadToGemini(
    ai: GoogleGenAI,
    filePath: string,
    mimeType: string = 'audio/mp3'
) {
    return ai.files.upload({
        file: filePath,
        config: { mimeType },
    });
}

async function waitForFilesActive(ai: GoogleGenAI, files: any[]): Promise<void> {
    for (const fileRef of files) {
        while (true) {
            const currentFile = await ai.files.get({ name: fileRef.name });
            if (currentFile.state === 'ACTIVE') break;
            if (currentFile.state === 'FAILED') {
                throw new Error(`File processing failed: ${currentFile.name}`);
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
    textEntries: TextChatEntry[]
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
    audioClips: StoredAudioClip[]
): Promise<{ uploadedFiles: any[]; audioParts: any[] }> {
    const uploadedFiles: any[] = [];
    const audioParts: any[] = [];

    for (const clip of audioClips) {
        const { userId, displayName, filePath, clipId } = clip;
        if (!fs.existsSync(filePath)) continue;

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

    return { uploadedFiles, audioParts };
}

async function cleanupUploads(ai: GoogleGenAI, uploadedFiles: any[]): Promise<void> {
    await Promise.all(
        uploadedFiles.map((fileRef) =>
            ai.files.delete({ name: fileRef.name }).catch(() => undefined)
        )
    );
}

export async function extractArticleTopics(
    audioClips: StoredAudioClip[],
    textEntries: TextChatEntry[],
    apiKey: string | null,
    modelName: string | null
): Promise<TopicExtractionResult> {
    if (audioClips.length === 0) {
        return { sessionSummary: '録音データがありませんでした。', topics: [] };
    }

    const ai = createAiClient(apiKey);
    const useModel = modelName || GEMINI_MODEL_FLASH;
    const { uploadedFiles, audioParts } = await uploadAudioParts(ai, audioClips);

    if (uploadedFiles.length === 0) {
        return { sessionSummary: '音声ファイルの準備に失敗しました。', topics: [] };
    }

    try {
        await waitForFilesActive(ai, uploadedFiles);

        // トピック抽出では、音声・テキスト・検索結果を 1 回の生成にまとめて渡す。
        const { response } = await generateContentWithWebSearch(
            ai,
            useModel,
            [
                { text: TOPIC_EXTRACTION_PROMPT },
                ...buildSharedParts(audioClips, textEntries),
                ...audioParts,
            ],
            {
                responseMimeType: 'application/json',
                isThinkingModel: useModel.includes('gemini-3.0') || useModel.includes('gemini-3.1'),
                forceSearch: true,
            },
        );

        return toJsonResult(response.text || '{"sessionSummary":"","topics":[]}');
    } finally {
        await cleanupUploads(ai, uploadedFiles);
    }
}

export async function generateArticleFromTopic(
    audioClips: StoredAudioClip[],
    textEntries: TextChatEntry[],
    topic: ArticleTopic,
    apiKey: string | null,
    modelName: string | null
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
                isThinkingModel: useModel.includes('gemini-3.0') || useModel.includes('gemini-3.1'),
                forceSearch: true,
            },
        );

        return response.text || '記事を生成できませんでした。';
    } finally {
        await cleanupUploads(ai, uploadedFiles);
    }
}
