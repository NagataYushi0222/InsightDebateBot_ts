import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, GEMINI_MODEL_FLASH } from '../config';
import { ARTICLE_GENERATION_PROMPT, TOPIC_EXTRACTION_PROMPT } from './prompts';
import { ArticleTopic, TextChatEntry, TopicExtractionResult } from './types';

function stripCodeFence(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    return text.trim();
}

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

function buildSharedParts(
    audioFilesMap: Map<string, string>,
    userMap: Map<string, string>,
    textEntries: TextChatEntry[]
): any[] {
    const parts: any[] = [];

    parts.push({
        text: `参加者一覧:\n${Array.from(audioFilesMap.keys()).map((userId, index) => {
            const name = userMap.get(userId) || `User_${userId}`;
            return `${index + 1}. ${name} [ID:${userId}]`;
        }).join('\n')}`,
    });

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
    audioFilesMap: Map<string, string>,
    userMap: Map<string, string>
): Promise<{ uploadedFiles: any[]; audioParts: any[] }> {
    const uploadedFiles: any[] = [];
    const audioParts: any[] = [];

    for (const [userId, filePath] of audioFilesMap.entries()) {
        if (!fs.existsSync(filePath)) continue;

        const userName = userMap.get(userId) || `User_${userId}`;
        const uploadedFile = await uploadToGemini(ai, filePath);
        uploadedFiles.push(uploadedFile);

        audioParts.push({ text: `発言者ラベル: ${userName} [ID:${userId}]` });
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
    audioFilesMap: Map<string, string>,
    userMap: Map<string, string>,
    textEntries: TextChatEntry[],
    apiKey: string | null,
    modelName: string | null
): Promise<TopicExtractionResult> {
    if (audioFilesMap.size === 0) {
        return { sessionSummary: '録音データがありませんでした。', topics: [] };
    }

    const ai = createAiClient(apiKey);
    const useModel = modelName || GEMINI_MODEL_FLASH;
    const { uploadedFiles, audioParts } = await uploadAudioParts(ai, audioFilesMap, userMap);

    if (uploadedFiles.length === 0) {
        return { sessionSummary: '音声ファイルの準備に失敗しました。', topics: [] };
    }

    try {
        await waitForFilesActive(ai, uploadedFiles);

        const response = await ai.models.generateContent({
            model: useModel,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: TOPIC_EXTRACTION_PROMPT },
                        ...buildSharedParts(audioFilesMap, userMap, textEntries),
                        ...audioParts,
                    ],
                },
            ],
            config: {
                responseMimeType: 'application/json',
            } as any,
        });

        return toJsonResult(response.text || '{"sessionSummary":"","topics":[]}');
    } finally {
        await cleanupUploads(ai, uploadedFiles);
    }
}

export async function generateArticleFromTopic(
    audioFilesMap: Map<string, string>,
    userMap: Map<string, string>,
    textEntries: TextChatEntry[],
    topic: ArticleTopic,
    apiKey: string | null,
    modelName: string | null
): Promise<string> {
    if (audioFilesMap.size === 0) {
        return '記事生成に必要な音声データがありません。';
    }

    const ai = createAiClient(apiKey);
    const useModel = modelName || GEMINI_MODEL_FLASH;
    const { uploadedFiles, audioParts } = await uploadAudioParts(ai, audioFilesMap, userMap);

    if (uploadedFiles.length === 0) {
        return '記事生成に必要な音声ファイルの準備に失敗しました。';
    }

    try {
        await waitForFilesActive(ai, uploadedFiles);

        const response = await ai.models.generateContent({
            model: useModel,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: ARTICLE_GENERATION_PROMPT },
                        {
                            text: `選択されたトピック:\n${JSON.stringify(topic, null, 2)}`,
                        },
                        ...buildSharedParts(audioFilesMap, userMap, textEntries),
                        ...audioParts,
                    ],
                },
            ],
        });

        return response.text || '記事を生成できませんでした。';
    } finally {
        await cleanupUploads(ai, uploadedFiles);
    }
}
