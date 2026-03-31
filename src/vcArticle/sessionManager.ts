import {
    AudioReceiveStream,
    EndBehaviorType,
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import { Client, Guild, Message, TextChannel } from 'discord.js';
import { cleanupFiles, convertToMp3 } from '../audioProcessor';
import { getGuildSettings } from '../database';
import { OpusDecoder } from '../opusDecoder';
import { UserAudioRecorder } from '../recorder';
import { extractArticleTopics, generateArticleFromTopic } from './ai';
import {
    loadArchivedSession,
    saveArchivedSession,
    StoredAudioClip,
    updateArchivedSessionSummaryLabel,
    updateArchivedSessionTopicResult,
} from './storage';
import { ArticleTopic, TextChatEntry, TopicExtractionResult } from './types';

const ARTICLE_CHUNK_INTERVAL_MS = 15 * 60 * 1000;

interface FinalizedArticleSession {
    archiveId: string | null;
    createdAt: string | null;
    voiceChannelName: string;
    summaryLabel: string | null;
    audioClips: StoredAudioClip[];
    textEntries: TextChatEntry[];
    topicResult: TopicExtractionResult | null;
}

export class VcArticleSession {
    public voiceConnection: VoiceConnection | null = null;
    public targetTextChannel: TextChannel | null = null;
    public isRecording = false;

    private readonly guildId: string;
    private recorder: UserAudioRecorder | null = null;
    private opusDecoders: Map<string, OpusDecoder> = new Map();
    private subscribedUsers: Set<string> = new Set();
    private textEntries: TextChatEntry[] = [];
    private userMap: Map<string, string> = new Map();
    private apiKey: string | null = null;
    private voiceChannelName = 'Voice Channel';
    private finalized: FinalizedArticleSession | null = null;
    private sessionStartedAt: Date | null = null;
    private pendingAudioClips: StoredAudioClip[] = [];
    private chunkTimer: ReturnType<typeof setInterval> | null = null;
    private chunkSequence = 0;
    private chunkProcessing: Promise<void> = Promise.resolve();

    constructor(guildId: string, _bot: Client) {
        this.guildId = guildId;
    }

    hasActiveConnection(): boolean {
        return !!this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed;
    }

    hasTopicCache(): boolean {
        return !!this.finalized?.topicResult;
    }

    getTopicResult(): TopicExtractionResult | null {
        return this.finalized?.topicResult || null;
    }

    getActiveArchiveId(): string | null {
        return this.finalized?.archiveId || null;
    }

    getActiveArchiveLabel(): string | null {
        return this.finalized?.summaryLabel || null;
    }

    getTopicById(id: number): ArticleTopic | null {
        const topics = this.finalized?.topicResult?.topics || [];
        return topics.find((topic) => topic.id === id) || null;
    }

    async startRecording(
        connection: VoiceConnection,
        channel: TextChannel,
        guild: Guild,
        apiKey: string | null,
        voiceChannelName: string
    ): Promise<void> {
        await this.clearFinalizedArtifacts();

        this.voiceConnection = connection;
        this.targetTextChannel = channel;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;
        this.apiKey = apiKey;
        this.voiceChannelName = voiceChannelName;
        this.textEntries = [];
        this.userMap = new Map();
        this.sessionStartedAt = new Date();
        this.pendingAudioClips = [];
        this.chunkSequence = 0;
        this.chunkProcessing = Promise.resolve();
        guild.members.cache.forEach((member) => {
            if (member.voice.channelId === connection.joinConfig.channelId && !member.user.bot) {
                this.userMap.set(member.id, member.displayName);
            }
        });
        this.chunkTimer = setInterval(() => {
            void this.enqueueChunkProcessing();
        }, ARTICLE_CHUNK_INTERVAL_MS);

        const receiver = connection.receiver;

        receiver.speaking.on('start', (userId: string) => {
            if (this.subscribedUsers.has(userId) || !this.recorder) return;
            this.subscribedUsers.add(userId);

            const opusStream = receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.Manual },
            });

            this.consumeAudioStream(guild, userId, opusStream);
        });
    }

    private consumeAudioStream(guild: Guild, userId: string, opusStream: AudioReceiveStream): void {
        if (!this.opusDecoders.has(userId)) {
            this.opusDecoders.set(userId, new OpusDecoder());
        }
        const decoder = this.opusDecoders.get(userId)!;
        const reader = opusStream.stream.getReader();

        const member = guild.members.cache.get(userId);
        if (member && !member.user.bot) {
            this.userMap.set(userId, member.displayName);
        }

        const readLoop = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done || !value) break;
                    if (!this.isRecording || !this.recorder) continue;

                    try {
                        const pcmData = decoder.decode(Buffer.from(value));
                        if (pcmData) {
                            this.recorder.write(userId, pcmData);
                        }
                    } catch {
                        // ignore packet decode errors
                    }
                }
            } catch (error) {
                console.error(`VC article audio stream error for ${userId}:`, error);
            } finally {
                this.subscribedUsers.delete(userId);
                this.opusDecoders.delete(userId);
            }
        };

        void readLoop();
    }

    recordTextMessage(message: Message): void {
        if (!this.isRecording || !this.targetTextChannel || !this.sessionStartedAt) return;
        if (message.author.bot) return;
        if (message.channelId !== this.targetTextChannel.id) return;
        if (message.createdAt < this.sessionStartedAt) return;

        this.textEntries.push({
            authorName: message.member?.displayName || message.author.username,
            content: message.content.trim(),
            timestamp: message.createdAt.toISOString(),
        });
    }

    async stopAndExtractTopics(): Promise<TopicExtractionResult> {
        if (!this.recorder || !this.isRecording) {
            throw new Error('記事化用の録音セッションは開始されていません。');
        }

        this.isRecording = false;
        this.clearChunkTimer();
        await this.enqueueChunkProcessing();

        if (this.pendingAudioClips.length === 0) {
            this.disposeVoiceConnection();
            this.resetLiveResources();
            return { sessionSummary: '録音データがありませんでした。', topics: [] };
        }

        const archived = saveArchivedSession({
            guildId: this.guildId,
            voiceChannelName: this.voiceChannelName,
            audioClips: this.pendingAudioClips,
            textEntries: this.textEntries,
            createdAt: this.sessionStartedAt || new Date(),
        });
        this.pendingAudioClips = [];

        const settings = getGuildSettings(this.guildId);
        const topicResult = await extractArticleTopics(
            archived.audioClips,
            archived.textEntries,
            this.apiKey,
            settings.model_name
        );
        const summaryLabel = updateArchivedSessionSummaryLabel(
            archived.archiveId,
            topicResult.sessionSummary || this.voiceChannelName
        );
        updateArchivedSessionTopicResult(archived.archiveId, topicResult);

        this.finalized = {
            archiveId: archived.archiveId,
            createdAt: archived.createdAt,
            voiceChannelName: archived.voiceChannelName,
            summaryLabel,
            audioClips: archived.audioClips,
            textEntries: archived.textEntries,
            topicResult,
        };

        this.disposeVoiceConnection();
        this.resetLiveResources();

        return topicResult;
    }

    async generateArticle(topicId: number): Promise<string> {
        if (!this.finalized?.topicResult) {
            throw new Error('先に `/article_stop` でトピック抽出を完了してください。');
        }

        const topic = this.getTopicById(topicId);
        if (!topic) {
            throw new Error(`トピック ${topicId} は見つかりませんでした。`);
        }

        const settings = getGuildSettings(this.guildId);
        return generateArticleFromTopic(
            this.finalized.audioClips,
            this.finalized.textEntries,
            topic,
            this.apiKey,
            settings.model_name
        );
    }

    async loadArchiveAndExtractTopics(archiveId: string, apiKey: string | null): Promise<TopicExtractionResult> {
        await this.clearFinalizedArtifacts();
        this.apiKey = apiKey;

        const archived = loadArchivedSession(archiveId, this.guildId);
        if (archived.topicResult) {
            this.finalized = {
                archiveId: archived.archiveId,
                createdAt: archived.createdAt,
                voiceChannelName: archived.voiceChannelName,
                summaryLabel: archived.summaryLabel,
                audioClips: archived.audioClips,
                textEntries: archived.textEntries,
                topicResult: archived.topicResult,
            };

            return archived.topicResult;
        }

        const settings = getGuildSettings(this.guildId);
        const topicResult = await extractArticleTopics(
            archived.audioClips,
            archived.textEntries,
            this.apiKey,
            settings.model_name
        );
        const summaryLabel = updateArchivedSessionSummaryLabel(
            archived.archiveId,
            topicResult.sessionSummary || archived.voiceChannelName
        );
        updateArchivedSessionTopicResult(archived.archiveId, topicResult);

        this.finalized = {
            archiveId: archived.archiveId,
            createdAt: archived.createdAt,
            voiceChannelName: archived.voiceChannelName,
            summaryLabel,
            audioClips: archived.audioClips,
            textEntries: archived.textEntries,
            topicResult,
        };

        return topicResult;
    }

    async discard(): Promise<void> {
        this.isRecording = false;
        this.clearChunkTimer();
        await this.chunkProcessing.catch(() => undefined);
        this.disposeVoiceConnection();
        this.resetLiveResources();
        await this.clearFinalizedArtifacts();
    }

    handleDestroyedConnection(connection: VoiceConnection): boolean {
        if (this.voiceConnection !== connection) return false;
        this.isRecording = false;
        this.clearChunkTimer();
        this.voiceConnection = null;
        this.resetLiveResources();
        return true;
    }

    private disposeVoiceConnection(): void {
        if (this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.voiceConnection.destroy();
        }
        this.voiceConnection = null;
    }

    private resetLiveResources(): void {
        cleanupFiles(this.pendingAudioClips.map((clip) => clip.filePath));
        this.recorder = null;
        this.opusDecoders.clear();
        this.subscribedUsers.clear();
        this.targetTextChannel = null;
        this.sessionStartedAt = null;
        this.pendingAudioClips = [];
        this.chunkSequence = 0;
    }

    private async clearFinalizedArtifacts(): Promise<void> {
        this.finalized = null;
    }

    private clearChunkTimer(): void {
        if (this.chunkTimer) {
            clearInterval(this.chunkTimer);
            this.chunkTimer = null;
        }
    }

    private async enqueueChunkProcessing(): Promise<void> {
        this.chunkProcessing = this.chunkProcessing
            .then(async () => {
                await this.flushCurrentChunk();
            })
            .catch((error) => {
                console.error(`[${this.guildId}] VC article chunk processing error:`, error);
            });

        await this.chunkProcessing;
    }

    private async flushCurrentChunk(): Promise<void> {
        if (!this.recorder) return;

        const rawFiles = await this.recorder.flushAudio();
        if (rawFiles.size === 0) return;

        const cleanupTargets: string[] = [];

        for (const [userId, pcmPath] of rawFiles.entries()) {
            cleanupTargets.push(pcmPath);
            const mp3Path = convertToMp3(pcmPath);
            if (!mp3Path) continue;

            this.chunkSequence += 1;
            this.pendingAudioClips.push({
                clipId: `${String(this.chunkSequence).padStart(4, '0')}_${Date.now()}`,
                userId,
                displayName: this.userMap.get(userId) || `User_${userId}`,
                filePath: mp3Path,
            });
        }

        cleanupFiles(cleanupTargets);
    }
}

export class VcArticleSessionManager {
    private readonly sessions = new Map<string, VcArticleSession>();

    constructor(private readonly bot: Client) {}

    getSession(guildId: string): VcArticleSession {
        let session = this.sessions.get(guildId);
        if (!session) {
            session = new VcArticleSession(guildId, this.bot);
            this.sessions.set(guildId, session);
        }
        return session;
    }

    async cleanupSession(guildId: string): Promise<void> {
        const session = this.getSession(guildId);
        await session.discard();
    }

    cleanupDestroyedConnection(guildId: string, connection: VoiceConnection): void {
        const session = this.sessions.get(guildId);
        if (!session) return;
        session.handleDestroyedConnection(connection);
    }
}
