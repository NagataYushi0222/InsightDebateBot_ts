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
import { ArticleTopic, TextChatEntry, TopicExtractionResult } from './types';

interface FinalizedArticleSession {
    audioFilesMap: Map<string, string>;
    userMap: Map<string, string>;
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
    private finalized: FinalizedArticleSession | null = null;
    private sessionStartedAt: Date | null = null;

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

    getTopicById(id: number): ArticleTopic | null {
        const topics = this.finalized?.topicResult?.topics || [];
        return topics.find((topic) => topic.id === id) || null;
    }

    async startRecording(
        connection: VoiceConnection,
        channel: TextChannel,
        guild: Guild,
        apiKey: string | null
    ): Promise<void> {
        await this.clearFinalizedArtifacts();

        this.voiceConnection = connection;
        this.targetTextChannel = channel;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;
        this.apiKey = apiKey;
        this.textEntries = [];
        this.userMap = new Map();
        this.sessionStartedAt = new Date();

        const voiceChannel = guild.channels.cache.get(channel.id) ?? guild.channels.cache.get(connection.joinConfig.channelId ?? '');
        if (voiceChannel?.isVoiceBased()) {
            voiceChannel.members.forEach((member) => {
                if (!member.user.bot) {
                    this.userMap.set(member.id, member.displayName);
                }
            });
        }

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

        const rawFiles = await this.recorder.flushAudio();
        const audioFilesMap = new Map<string, string>();
        const cleanupTargets: string[] = [];

        for (const [userId, pcmPath] of rawFiles.entries()) {
            cleanupTargets.push(pcmPath);
            const mp3Path = convertToMp3(pcmPath);
            if (mp3Path) {
                audioFilesMap.set(userId, mp3Path);
            }
        }

        cleanupFiles(cleanupTargets);

        const settings = getGuildSettings(this.guildId);
        const topicResult = await extractArticleTopics(
            audioFilesMap,
            this.userMap,
            this.textEntries,
            this.apiKey,
            settings.model_name
        );

        this.finalized = {
            audioFilesMap,
            userMap: new Map(this.userMap),
            textEntries: [...this.textEntries],
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
            this.finalized.audioFilesMap,
            this.finalized.userMap,
            this.finalized.textEntries,
            topic,
            this.apiKey,
            settings.model_name
        );
    }

    async discard(): Promise<void> {
        this.isRecording = false;
        this.disposeVoiceConnection();
        this.resetLiveResources();
        await this.clearFinalizedArtifacts();
    }

    handleDestroyedConnection(connection: VoiceConnection): boolean {
        if (this.voiceConnection !== connection) return false;
        this.isRecording = false;
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
        this.recorder = null;
        this.opusDecoders.clear();
        this.subscribedUsers.clear();
        this.targetTextChannel = null;
        this.sessionStartedAt = null;
    }

    private async clearFinalizedArtifacts(): Promise<void> {
        if (!this.finalized) return;
        cleanupFiles(Array.from(this.finalized.audioFilesMap.values()));
        this.finalized = null;
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
