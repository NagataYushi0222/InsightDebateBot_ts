import {
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import { Client, Guild, Message, TextChannel } from 'discord.js';
import { cleanupFiles, convertToMp3 } from '../audioProcessor';
import { getGuildSettings } from '../database';
import { UserAudioRecorder } from '../recorder';
import { attachVoiceCaptureConsumer } from '../voiceCaptureHub';
import type { VoiceConsumerDiagnosticsSnapshot } from '../voiceDiagnostics';
import {
    ArticleProgressReporter,
    extractArticleTopics,
    generateArticleFromTopic,
} from './ai';
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
    private detachVoiceCapture: (() => void) | null = null;
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
    private isStopping = false;
    private readonly consumerLabel: string;
    private lastVoiceStats: VoiceConsumerDiagnosticsSnapshot | null = null;

    constructor(guildId: string) {
        this.guildId = guildId;
        this.consumerLabel = `article:${guildId}`;
    }

    hasActiveConnection(): boolean {
        return !!this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed;
    }

    isBusy(): boolean {
        return this.isRecording || this.isStopping;
    }

    isStoppingInProgress(): boolean {
        return this.isStopping;
    }

    hasTopicCache(): boolean {
        return !!this.finalized?.topicResult;
    }

    getStatusSummary(): {
        status: string;
        task: string;
        pendingClipCount: number;
        textEntryCount: number;
        topicCount: number;
        activeArchiveId: string | null;
        activeArchiveLabel: string | null;
    } {
        const topicCount = this.finalized?.topicResult?.topics.length || 0;

        if (this.isStopping) {
            return {
                status: '停止処理中',
                task: 'VC から離脱し、保存済み音声から記事候補を抽出しています',
                pendingClipCount: this.pendingAudioClips.length,
                textEntryCount: this.textEntries.length,
                topicCount,
                activeArchiveId: this.finalized?.archiveId || null,
                activeArchiveLabel: this.finalized?.summaryLabel || null,
            };
        }

        if (this.isRecording) {
            return {
                status: '録音中',
                task: '15分ごとに音声断片を確定しながら記事化用の素材を収集しています',
                pendingClipCount: this.pendingAudioClips.length,
                textEntryCount: this.textEntries.length,
                topicCount,
                activeArchiveId: this.finalized?.archiveId || null,
                activeArchiveLabel: this.finalized?.summaryLabel || null,
            };
        }

        if (this.finalized?.topicResult) {
            return {
                status: 'トピック保持中',
                task: '保存済みの候補トピックを保持しており、記事生成を待機しています',
                pendingClipCount: this.finalized.audioClips.length,
                textEntryCount: this.finalized.textEntries.length,
                topicCount,
                activeArchiveId: this.finalized.archiveId,
                activeArchiveLabel: this.finalized.summaryLabel,
            };
        }

        return {
            status: '停止中',
            task: '記事化モードは待機しています',
            pendingClipCount: 0,
            textEntryCount: 0,
            topicCount: 0,
            activeArchiveId: null,
            activeArchiveLabel: null,
        };
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
        this.lastVoiceStats = null;
        guild.members.cache.forEach((member) => {
            if (member.voice.channelId === connection.joinConfig.channelId && !member.user.bot) {
                this.userMap.set(member.id, member.displayName);
            }
        });
        this.chunkTimer = setInterval(() => {
            void this.enqueueChunkProcessing();
        }, ARTICLE_CHUNK_INTERVAL_MS);
        this.detachFromVoiceCapture();
        this.detachVoiceCapture = attachVoiceCaptureConsumer(connection, {
            consumerLabel: this.consumerLabel,
            onSpeakerStart: (userId) => {
                this.rememberDisplayName(guild, userId);
            },
            onAudio: (userId, pcmData) => {
                if (!this.isRecording || !this.recorder) return;
                if (!this.userMap.has(userId)) {
                    this.rememberDisplayName(guild, userId);
                }
                this.recorder.write(userId, pcmData);
            },
            onStats: (stats) => {
                this.lastVoiceStats = stats;
            },
        });
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

    async stopAndExtractTopics(
        destroyConnection: boolean = true,
        onProgress?: ArticleProgressReporter,
    ): Promise<TopicExtractionResult> {
        if (!this.recorder || !this.isRecording) {
            throw new Error('記事化用の録音セッションは開始されていません。');
        }

        this.isStopping = true;
        this.isRecording = false;
        this.detachFromVoiceCapture();
        this.logVoiceStats('stop_and_extract');
        this.clearChunkTimer();
        await this.enqueueChunkProcessing();

        // 録音停止後はすぐ VC から離れ、以後の保存と AI 処理は録音外で進める。
        this.releaseVoiceConnection(destroyConnection);

        const pendingAudioClips = [...this.pendingAudioClips];
        const textEntries = [...this.textEntries];
        const voiceChannelName = this.voiceChannelName;
        const createdAt = this.sessionStartedAt || new Date();
        const apiKey = this.apiKey;
        this.recorder = null;
        this.targetTextChannel = null;
        this.sessionStartedAt = null;
        this.pendingAudioClips = [];
        this.chunkSequence = 0;
        this.textEntries = [];
        this.userMap = new Map();

        try {
            if (pendingAudioClips.length === 0) {
                return { sessionSummary: '録音データがありませんでした。', topics: [] };
            }

            // stop 時点の断片をいったんアーカイブへ固め、以後は保存済みファイルを読む。
            const archived = saveArchivedSession({
                guildId: this.guildId,
                voiceChannelName,
                audioClips: pendingAudioClips,
                textEntries,
                createdAt,
            });

            this.finalized = {
                archiveId: archived.archiveId,
                createdAt: archived.createdAt,
                voiceChannelName: archived.voiceChannelName,
                summaryLabel: archived.summaryLabel,
                audioClips: archived.audioClips,
                textEntries: archived.textEntries,
                topicResult: archived.topicResult,
            };

            const settings = getGuildSettings(this.guildId);
            const topicResult = await extractArticleTopics(
                archived.audioClips,
                archived.textEntries,
                apiKey,
                settings.model_name,
                onProgress,
            );
            const summaryLabel = updateArchivedSessionSummaryLabel(
                archived.archiveId,
                topicResult.sessionSummary || voiceChannelName
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
        } catch (error) {
            cleanupFiles(pendingAudioClips.map((clip) => clip.filePath));
            throw error;
        } finally {
            this.isStopping = false;
        }
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

    async loadArchiveAndExtractTopics(
        archiveId: string,
        apiKey: string | null,
        onProgress?: ArticleProgressReporter,
    ): Promise<TopicExtractionResult> {
        await this.clearFinalizedArtifacts();
        this.apiKey = apiKey;

        console.log(`[VC Article] Loading archive ${archiveId}`);
        const archived = loadArchivedSession(archiveId, this.guildId);
        if (archived.topicResult) {
            console.log(`[VC Article] Reusing cached topics for archive ${archiveId}`);
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

        console.log(`[VC Article] Cached topics were missing for archive ${archiveId}; regenerating`);
        const settings = getGuildSettings(this.guildId);
        const topicResult = await extractArticleTopics(
            archived.audioClips,
            archived.textEntries,
            this.apiKey,
            settings.model_name,
            onProgress,
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

    async discard(destroyConnection: boolean = true): Promise<void> {
        this.isStopping = false;
        this.isRecording = false;
        this.detachFromVoiceCapture();
        this.logVoiceStats('discard');
        this.clearChunkTimer();
        await this.chunkProcessing.catch(() => undefined);
        this.releaseVoiceConnection(destroyConnection);
        this.resetLiveResources();
        await this.clearFinalizedArtifacts();
    }

    handleDestroyedConnection(connection: VoiceConnection): boolean {
        if (this.voiceConnection !== connection) return false;
        this.isRecording = false;
        this.isStopping = false;
        this.detachFromVoiceCapture();
        this.logVoiceStats('connection_destroyed');
        this.clearChunkTimer();
        this.voiceConnection = null;
        this.resetLiveResources();
        return true;
    }

    private releaseVoiceConnection(destroyConnection: boolean): void {
        const connection = this.voiceConnection;
        this.voiceConnection = null;

        if (destroyConnection && connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
        }
    }

    private resetLiveResources(): void {
        cleanupFiles(this.pendingAudioClips.map((clip) => clip.filePath));
        this.recorder = null;
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

    private detachFromVoiceCapture(): void {
        if (!this.detachVoiceCapture) {
            return;
        }

        this.detachVoiceCapture();
        this.detachVoiceCapture = null;
    }

    private logVoiceStats(reason: string): void {
        if (!this.lastVoiceStats) {
            console.log(`[Voice Metrics][${this.consumerLabel}][${reason}] no stats captured`);
            return;
        }

        if (this.lastVoiceStats.users.length === 0) {
            console.log(`[Voice Metrics][${this.consumerLabel}][${reason}] no user audio captured`);
            return;
        }

        for (const user of this.lastVoiceStats.users) {
            console.log(
                [
                    `[Voice Metrics][${this.consumerLabel}][${reason}]`,
                    `user=${user.userId}`,
                    `dave_ok=${user.daveDecryptSuccesses}`,
                    `dave_fail=${user.daveDecryptFailures}`,
                    `opus_ok=${user.opusPacketsReceived}`,
                    `opus_decode_fail=${user.opusDecodeFailures}`,
                    `pcm_packets=${user.pcmPacketsDelivered}`,
                    `pcm_bytes=${user.pcmBytesDelivered}`,
                ].join(' '),
            );
        }
    }

    private rememberDisplayName(guild: Guild, userId: string): void {
        const member = guild.members.cache.get(userId);
        if (member && !member.user.bot) {
            this.userMap.set(userId, member.displayName);
            return;
        }

        void guild.members.fetch(userId)
            .then((fetchedMember) => {
                if (!fetchedMember.user.bot) {
                    this.userMap.set(userId, fetchedMember.displayName);
                }
            })
            .catch(() => undefined);
    }
}

export class VcArticleSessionManager {
    private readonly sessions = new Map<string, VcArticleSession>();

    constructor(_bot: Client) {
        void _bot;
    }

    getSession(guildId: string): VcArticleSession {
        let session = this.sessions.get(guildId);
        if (!session) {
            session = new VcArticleSession(guildId);
            this.sessions.set(guildId, session);
        }
        return session;
    }

    getExistingSession(guildId: string): VcArticleSession | null {
        return this.sessions.get(guildId) || null;
    }

    listSessionGuildIds(): string[] {
        return Array.from(this.sessions.keys());
    }

    async cleanupSession(guildId: string, destroyConnection: boolean = true): Promise<void> {
        const session = this.getSession(guildId);
        await session.discard(destroyConnection);
    }

    cleanupDestroyedConnection(guildId: string, connection: VoiceConnection): void {
        const session = this.sessions.get(guildId);
        if (!session) return;
        session.handleDestroyedConnection(connection);
    }
}
