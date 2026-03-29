import {
    VoiceConnection,
    AudioReceiveStream,
    EndBehaviorType,
    VoiceConnectionStatus,
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
    public targetTextChannel: TextChannel | null = null;
    private lastContext: string = '';
    private isProcessLoopRunning: boolean = false;
    public isRecording: boolean = false;
    private settings: GuildSettings;
    private opusDecoders: Map<string, OpusDecoder> = new Map();
    private subscribedUsers: Set<string> = new Set();
    private apiKey: string | null = null;
    private countdownMessage: any = null;
    private voiceChannelName: string = '';
    private cycleStartedAt: number | null = null;
    private currentStatus: string = '停止中';
    private currentTaskLabel: string = '待機中';
    private lastStatusContent: string = '';
    private isProcessingAudio: boolean = false;

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
        channel: TextChannel,
        apiKey: string | null = null,
        initialMessage: any = null,
        voiceChannelName: string = 'Voice Channel'
    ): Promise<void> {
        this.voiceConnection = connection;
        this.targetTextChannel = channel;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;
        this.apiKey = apiKey;
        this.countdownMessage = initialMessage;
        this.voiceChannelName = voiceChannelName;
        this.cycleStartedAt = Date.now();
        this.currentStatus = '録音中';
        this.currentTaskLabel = '次回の自動分析を待機中';
        await this.refreshStatusMessage();

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
        this.isProcessLoopRunning = true;
        this.processLoop();
    }

    hasActiveConnection(): boolean {
        return !!this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed;
    }

    handleDestroyedConnection(connection: VoiceConnection): boolean {
        if (this.voiceConnection !== connection) return false;

        this.isProcessLoopRunning = false;
        this.isRecording = false;
        this.isProcessingAudio = false;
        this.voiceConnection = null;
        this.recorder = null;
        this.opusDecoders.clear();
        this.subscribedUsers.clear();
        this.countdownMessage = null;
        this.currentStatus = '切断済み';
        this.currentTaskLabel = '接続が破棄されました';
        this.cycleStartedAt = null;

        return true;
    }

    /**
     * 録音を停止する
     */
    async stopRecording(skipFinal: boolean = false): Promise<void> {
        this.isProcessLoopRunning = false;
        this.currentStatus = skipFinal ? '停止処理中' : '最終分析中';
        this.currentTaskLabel = skipFinal ? '録音を停止しています' : '終了前の最終分析を準備しています';
        await this.refreshStatusMessage();
        
        if (!skipFinal && this.voiceConnection && this.isRecording && this.recorder) {
            if (this.targetTextChannel) {
                await this.targetTextChannel.send("🔄 終了前の最終分析を行っています...しばらくお待ちください。");
            }
            await this.processAudio(false, true);
        }

        this.isRecording = false;
        this.isProcessingAudio = false;
        this.cycleStartedAt = null;
        this.currentStatus = '停止中';
        this.currentTaskLabel = '録音は停止しています';

        // デコーダーのクリーンアップ
        this.opusDecoders.clear();
        this.subscribedUsers.clear();

        if (this.voiceConnection) {
            if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                this.voiceConnection.destroy();
            }
            this.voiceConnection = null;
        }

        this.recorder = null;
        await this.refreshStatusMessage();
    }

    getRemainingSeconds(): number | null {
        if (!this.isRecording || this.cycleStartedAt === null) return null;

        const interval = getGuildSettings(this.guildId).recording_interval || 300;
        const elapsed = Math.floor((Date.now() - this.cycleStartedAt) / 1000);
        return Math.max(0, interval - elapsed);
    }

    getStatusSummary(): { status: string; task: string; remainingSeconds: number | null } {
        return {
            status: this.currentStatus,
            task: this.currentTaskLabel,
            remainingSeconds: this.getRemainingSeconds(),
        };
    }

    async syncSettingsAndStatus(): Promise<void> {
        this.settings = getGuildSettings(this.guildId);
        await this.refreshStatusMessage();
    }

    private formatRemaining(seconds: number | null): string {
        if (seconds === null) return '停止中';

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    private buildStatusMessage(): string {
        this.settings = getGuildSettings(this.guildId);
        const interval = this.settings.recording_interval || 300;
        const intervalLabel = interval >= 60
            ? `${interval}秒 (${(interval / 60).toFixed(1)}分)`
            : `${interval}秒`;
        const remaining = this.getRemainingSeconds();

        return [
            `👥｜**${this.voiceChannelName}** の分析を実行中です。`,
            'プライバシー保護のため、録音・分析が行われることを参加者に周知してください。',
            `\`[設定] 間隔: ${intervalLabel} / モード: ${this.settings.analysis_mode}\``,
            `📡 現在の状態: **${this.currentStatus}**`,
            `🛠️ 現在の処理: ${this.currentTaskLabel}`,
            `⏳ 次のレポート出力まで: ${this.formatRemaining(remaining)}`,
        ].join('\n');
    }

    private async refreshStatusMessage(force: boolean = false): Promise<void> {
        const nextContent = this.buildStatusMessage();
        if (!force && nextContent === this.lastStatusContent) return;

        if (!this.countdownMessage && this.targetTextChannel) {
            try {
                this.countdownMessage = await this.targetTextChannel.send(nextContent);
                this.lastStatusContent = nextContent;
                return;
            } catch {
                return;
            }
        }

        if (!this.countdownMessage) return;

        try {
            await this.countdownMessage.edit({ content: nextContent });
            this.lastStatusContent = nextContent;
        } catch {
            this.countdownMessage = null;
            this.lastStatusContent = '';
        }
    }

    /**
     * 定期分析ループ
     */
    private async processLoop(): Promise<void> {
        while (this.isProcessLoopRunning) {
            this.cycleStartedAt = Date.now();
            this.currentStatus = '録音中';
            this.currentTaskLabel = '次回の自動分析を待機中';
            await this.refreshStatusMessage(true);

            while (this.isProcessLoopRunning) {
                try {
                    this.settings = getGuildSettings(this.guildId);
                    const remainingSeconds = this.getRemainingSeconds();
                    await this.refreshStatusMessage();

                    if (remainingSeconds !== null && remainingSeconds <= 0) {
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 5000));
                } catch (e) {
                    break;
                }
            }

            if (!this.isProcessLoopRunning) break;

            await this.processAudio(false, false);
        }
    }

    /**
     * 蓄積された音声を分析する
     */
    public async processAudio(isManual: boolean = false, isFinal: boolean = false): Promise<void> {
        if (!this.recorder || !this.isRecording) return;
        if (this.isProcessingAudio) return;

        this.isProcessingAudio = true;

        const jobName = isManual ? 'Manual analysis' : 'Periodic analysis';
        console.log(`[${this.guildId}] Starting ${jobName}...`);

        try {
            this.currentStatus = isFinal ? '最終分析中' : isManual ? '手動分析中' : '自動分析中';
            this.currentTaskLabel = '音声を確定しています';
            await this.refreshStatusMessage(true);

            const userFilesRaw = await this.recorder.flushAudio();

            if (userFilesRaw.size === 0) {
                this.currentStatus = '録音中';
                this.currentTaskLabel = isManual ? '新しい音声がなかったため待機中' : '次回の自動分析を待機中';
                await this.refreshStatusMessage(true);
                return;
            }

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
            this.currentTaskLabel = 'エンコード中';
            await this.refreshStatusMessage(true);

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
            // JST (UTC+9) への変換処理
            now.setHours(now.getUTCHours() + 9);
            const timestampStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

            let threadName = `議論分析レポート ${timestampStr}`;
            let headerPrefix = '📊 **議論分析レポート**';
            if (isFinal) {
                threadName = `議論分析レポート (最終) ${timestampStr}`;
                headerPrefix = '🏁 **最終分析レポート**';
            } else if (isManual) {
                threadName = `手動分析レポート ${timestampStr}`;
                headerPrefix = '🚀 **手動分析レポート**';
            }

            try {
                if (!this.targetTextChannel) return;

                const apiKeyToUse = this.apiKey;
                if (!apiKeyToUse) {
                    await this.targetTextChannel.send("⚠️ エラー: APIキーが設定されていません。");
                    return;
                }

                // 分析実行（スレッド作成前に行う）
                this.currentTaskLabel = '回答生成中';
                await this.refreshStatusMessage(true);
                const report = await analyzeDiscussion(
                    userFilesMp3,
                    this.lastContext,
                    userMap,
                    apiKeyToUse,
                    this.settings.analysis_mode,
                    this.settings.model_name
                );

                if (!report || report.startsWith("⚠️") || report.startsWith("音声データがありません") || report.startsWith("❌")) {
                    console.log(`[${this.guildId}] Analysis skipped or failed: ${report}`);
                    let msg = "⚠️ 予期せぬエラーでレポートを作成できませんでした。";
                    if (report.startsWith("音声データがありません")) {
                        msg = "🎤 音声が検出されませんでした（無音）。";
                    } else if (report.startsWith("⚠️") || report.startsWith("❌")) {
                        msg = `⚠️ 分析エラー: ${report}`;
                    }
                    
                    if (this.targetTextChannel) {
                        await this.targetTextChannel.send(msg);
                        if (isFinal) {
                            await this.targetTextChannel.send("🛑 セッションを終了します。");
                        }
                    }
                    return;
                }

                // コンテキストを更新
                this.lastContext = report.slice(-2000);
                this.currentTaskLabel = 'レポート投稿中';
                await this.refreshStatusMessage(true);

                let titleText = `📅 自動分析 (${timestampStr})`;
                let embedColor = 0x3498db; // Blue
                if (isFinal) {
                    titleText = `🛑 セッション終了 (${timestampStr})`;
                    embedColor = 0xe74c3c; // Red
                } else if (isManual) {
                    titleText = `📅 手動分析 (${timestampStr})`;
                }

                const previewLength = 300;
                let previewText = report.slice(0, previewLength).trim();
                if (report.length > previewLength) {
                    previewText += "...\n\n";
                }

                const embed = {
                    title: titleText,
                    description: `${previewText}\n*(全文はスレッドを開いてご確認ください)*`,
                    color: embedColor
                };

                const starterMsg = await this.targetTextChannel.send({ embeds: [embed] });
                const reportThread = await starterMsg.startThread({
                    name: threadName,
                    autoArchiveDuration: 60,
                });

                // レポートを投稿
                const header = `${headerPrefix}\n`;
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
        } finally {
            this.isProcessingAudio = false;

            if (this.isRecording && this.isProcessLoopRunning) {
                this.currentStatus = '録音中';
                this.currentTaskLabel = '次回の自動分析を待機中';
                if (!isManual && !isFinal) {
                    this.cycleStartedAt = Date.now();
                }
            } else if (this.isRecording) {
                this.currentStatus = '録音中';
                this.currentTaskLabel = '待機中';
            } else {
                this.currentStatus = '停止中';
                this.currentTaskLabel = '録音は停止しています';
                this.cycleStartedAt = null;
            }

            await this.refreshStatusMessage(true);
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

    async cleanupSession(guildId: string, skipFinal: boolean = false): Promise<void> {
        if (this.sessions.has(guildId)) {
            await this.sessions.get(guildId)!.stopRecording(skipFinal);
            this.sessions.delete(guildId);
        }
    }

    cleanupDestroyedConnection(guildId: string, connection: VoiceConnection): void {
        const session = this.sessions.get(guildId);
        if (!session) return;

        if (session.handleDestroyedConnection(connection)) {
            this.sessions.delete(guildId);
        }
    }
}
