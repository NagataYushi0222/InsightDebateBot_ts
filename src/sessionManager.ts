import {
    VoiceConnection,
    AudioReceiveStream,
    EndBehaviorType,
} from '@ovencord/voice';
import { Client, TextChannel, Guild } from 'discord.js';
import { UserAudioRecorder } from './recorder';
import { convertToMp3, cleanupFiles } from './audioProcessor';
import { analyzeDiscussion } from './analyzer';
import { getGuildSettings, GuildSettings } from './database';
import { OpusDecoder } from './opusDecoder';

/**
 * ギルドごとのセッション
 */
export class GuildSession {
    public guildId: string;
    private bot: Client;
    public voiceConnection: VoiceConnection | null = null;
    private recorder: UserAudioRecorder | null = null;
    private targetTextChannel: TextChannel | null = null;
    private lastContext: string = '';
    private processLoopTimer: ReturnType<typeof setTimeout> | null = null;
    private isRecording: boolean = false;
    private settings: GuildSettings;
    private opusDecoders: Map<string, OpusDecoder> = new Map();
    private subscribedUsers: Set<string> = new Set();

    constructor(guildId: string, bot: Client) {
        this.guildId = guildId;
        this.bot = bot;
        this.settings = getGuildSettings(guildId);
    }

    /**
     * 録音を開始する
     */
    async startRecording(
        connection: VoiceConnection,
        channel: TextChannel
    ): Promise<void> {
        this.voiceConnection = connection;
        this.targetTextChannel = channel;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;

        // ボイス受信のセットアップ
        const receiver = connection.receiver;

        // speaking イベントでユーザーの音声ストリームを取得
        receiver.speaking.on('start', (userId: string) => {
            if (this.subscribedUsers.has(userId)) return;
            this.subscribedUsers.add(userId);

            const opusStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.Manual,
                },
            });

            // Opus デコーダーを作成
            if (!this.opusDecoders.has(userId)) {
                this.opusDecoders.set(userId, new OpusDecoder());
            }
            const decoder = this.opusDecoders.get(userId)!;

            // Web Streams APIのリーダーでOpusパケットを読み取る
            const reader = opusStream.stream.getReader();
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
                        } catch (e) {
                            // デコードエラーは無視（パケットロス等）
                        }
                    }
                } catch (err: any) {
                    console.error(`Audio stream error for user ${userId}:`, err.message);
                } finally {
                    this.subscribedUsers.delete(userId);
                    this.opusDecoders.delete(userId);
                }
            };
            readLoop();
        });

        // 定期分析ループを開始
        this.scheduleProcessLoop();
    }

    /**
     * 録音を停止する
     */
    async stopRecording(): Promise<void> {
        this.isRecording = false;

        if (this.processLoopTimer) {
            clearTimeout(this.processLoopTimer);
            this.processLoopTimer = null;
        }

        // デコーダーのクリーンアップ
        this.opusDecoders.clear();
        this.subscribedUsers.clear();

        if (this.voiceConnection) {
            this.voiceConnection.destroy();
            this.voiceConnection = null;
        }

        this.recorder = null;
    }

    /**
     * 定期分析ループのスケジュール
     */
    private scheduleProcessLoop(): void {
        // 現在の設定を取得
        this.settings = getGuildSettings(this.guildId);
        const interval = (this.settings.recording_interval || 300) * 1000;

        this.processLoopTimer = setTimeout(async () => {
            await this.processAudio(false);
            // 次のループをスケジュール
            if (this.isRecording) {
                this.scheduleProcessLoop();
            }
        }, interval);
    }

    /**
     * 蓄積された音声を分析する
     */
    public async processAudio(isManual: boolean = false): Promise<void> {
        if (!this.recorder || !this.isRecording) return;

        const jobName = isManual ? 'Manual analysis' : 'Periodic analysis';
        console.log(`[${this.guildId}] Starting ${jobName}...`);

        try {
            const userFilesRaw = this.recorder.flushAudio();

            if (userFilesRaw.size === 0) return;

            // ユーザー名マッピング
            const userMap = new Map<string, string>();
            let guild: Guild | undefined;

            try {
                guild = this.bot.guilds.cache.get(this.guildId);
            } catch {
                // ignore
            }

            for (const userId of userFilesRaw.keys()) {
                let displayName = `User_${userId}`;

                if (guild) {
                    const member = guild.members.cache.get(userId);
                    if (member) {
                        displayName = member.displayName;
                    } else {
                        try {
                            const fetchedMember = await guild.members.fetch(userId);
                            displayName = fetchedMember.displayName;
                        } catch {
                            try {
                                const user = await this.bot.users.fetch(userId);
                                displayName = user.displayName;
                            } catch {
                                // keep default
                            }
                        }
                    }
                }

                userMap.set(userId, displayName);
            }

            // PCM → MP3 変換
            const userFilesMp3 = new Map<string, string>();
            const filesToCleanup: string[] = Array.from(userFilesRaw.values());

            for (const [userId, rawPath] of userFilesRaw.entries()) {
                const mp3Path = convertToMp3(rawPath);
                if (mp3Path) {
                    userFilesMp3.set(userId, mp3Path);
                    filesToCleanup.push(mp3Path);
                }
            }

            if (userFilesMp3.size === 0) {
                cleanupFiles(filesToCleanup);
                return;
            }

            // スレッドの作成とレポート送信
            const now = new Date();
            const timestampStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const threadName = isManual
                ? `手動分析レポート ${timestampStr}`
                : `議論分析レポート ${timestampStr}`;

            try {
                if (!this.targetTextChannel) return;

                // 分析実行（スレッド作成前に行う）
                const report = await analyzeDiscussion(
                    userFilesMp3,
                    this.lastContext,
                    userMap,
                    this.settings.api_key,
                    this.settings.analysis_mode,
                    this.settings.model_name
                );

                // コンテキストを更新
                this.lastContext = report.slice(-2000);

                const autoStr = isManual ? '手動分析' : '自動分析';
                const starterMsg = await this.targetTextChannel.send(
                    `📅 **${autoStr}** (${timestampStr})`
                );
                const reportThread = await starterMsg.startThread({
                    name: threadName,
                    autoArchiveDuration: 60,
                });

                // レポートを投稿
                const header = isManual
                    ? '🚀 **手動分析レポート**\n'
                    : '📊 **議論分析レポート**\n';
                if (report.length + header.length < 2000) {
                    await reportThread.send(header + report);
                } else {
                    await reportThread.send(header);
                    for (let i = 0; i < report.length; i += 1900) {
                        await reportThread.send(report.slice(i, i + 1900));
                    }
                }
            } catch (e) {
                console.error(`[${this.guildId}] Error in reporting:`, e);
                if (this.targetTextChannel) {
                    await this.targetTextChannel.send(`⚠️ エラー: ${e}`);
                }
            } finally {
                cleanupFiles(filesToCleanup);
            }
        } catch (e) {
            console.error(`[${this.guildId}] Error in processAudio:`, e);
        }
    }
}

/**
 * セッションマネージャー
 */
export class SessionManager {
    private bot: Client;
    private sessions: Map<string, GuildSession> = new Map();

    constructor(bot: Client) {
        this.bot = bot;
    }

    getSession(guildId: string): GuildSession {
        if (!this.sessions.has(guildId)) {
            this.sessions.set(guildId, new GuildSession(guildId, this.bot));
        }
        return this.sessions.get(guildId)!;
    }

    async cleanupSession(guildId: string): Promise<void> {
        if (this.sessions.has(guildId)) {
            await this.sessions.get(guildId)!.stopRecording();
            this.sessions.delete(guildId);
        }
    }
}
