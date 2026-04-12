import {
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import { Client, TextChannel, Guild } from 'discord.js';
import { UserAudioRecorder } from './recorder';
import { convertToMp3, cleanupFiles } from './audioProcessor';
import { analyzeDiscussion } from './analyzer';
import { getGuildSettings, GuildSettings } from './database';
import { attachVoiceCaptureConsumer } from './voiceCaptureHub';
import type { VoiceConsumerDiagnosticsSnapshot } from './voiceDiagnostics';

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
    private detachVoiceCapture: (() => void) | null = null;
    private apiKey: string | null = null;
    private voiceChannelName: string = '';
    private cycleStartedAt: number | null = null;
    private currentStatus: string = '停止中';
    private currentTaskLabel: string = '待機中';
    private isProcessingAudio: boolean = false;
    // stop 中に start/now が割り込まないように、終了処理中を明示的に持つ。
    private isStopping: boolean = false;
    // stop 時に「定期ループが本当に止まったか」を待つための Promise。
    private processLoopPromise: Promise<void> | null = null;
    private processLoopWaitResolver: (() => void) | null = null;
    // 最終分析と定期分析が二重起動しないよう、分析処理を 1 本に制限する。
    private processingPromise: Promise<void> | null = null;
    private readonly consumerLabel: string;
    private lastVoiceStats: VoiceConsumerDiagnosticsSnapshot | null = null;

    constructor(guildId: string, bot: Client) {
        this.guildId = guildId;
        this.bot = bot;
        this.settings = getGuildSettings(guildId);
        this.consumerLabel = `analyze:${guildId}`;
    }

    /**
     * 録音を開始する
     */
    async startRecording(
        connection: VoiceConnection,
        channel: TextChannel,
        apiKey: string | null = null,
        voiceChannelName: string = 'Voice Channel'
    ): Promise<void> {
        this.voiceConnection = connection;
        this.targetTextChannel = channel;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;
        this.apiKey = apiKey;
        this.voiceChannelName = voiceChannelName;
        this.lastVoiceStats = null;
        this.cycleStartedAt = Date.now();
        this.currentStatus = '録音中';
        this.currentTaskLabel = '次回の自動分析を待機中';
        await this.refreshStatusMessage(undefined, true);
        this.detachFromVoiceCapture();
        this.detachVoiceCapture = attachVoiceCaptureConsumer(connection, {
            consumerLabel: this.consumerLabel,
            onAudio: (userId, pcmData) => {
                if (!this.isRecording || !this.recorder) return;
                this.recorder.write(userId, pcmData);
            },
            onStats: (stats) => {
                this.lastVoiceStats = stats;
            },
        });

        // 定期分析ループを開始
        this.isProcessLoopRunning = true;
        this.isStopping = false;
        let loopPromise: Promise<void>;
        loopPromise = this.processLoop()
            .catch((error) => {
                console.error(`[${this.guildId}] Error in process loop:`, error);
            })
            .finally(() => {
                if (this.processLoopPromise === loopPromise) {
                    this.processLoopPromise = null;
                }
                this.processLoopWaitResolver = null;
            });
        this.processLoopPromise = loopPromise;
    }

    hasActiveConnection(): boolean {
        return !!this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed;
    }

    isBusy(): boolean {
        return this.isRecording || this.isStopping || !!this.processingPromise;
    }

    isStoppingInProgress(): boolean {
        return this.isStopping;
    }

    handleDestroyedConnection(connection: VoiceConnection): boolean {
        if (this.voiceConnection !== connection) return false;

        this.isProcessLoopRunning = false;
        this.isRecording = false;
        this.isStopping = false;
        this.isProcessingAudio = false;
        this.resolveProcessLoopWait();
        this.detachFromVoiceCapture();
        this.logVoiceStats('connection_destroyed');
        this.voiceConnection = null;
        this.recorder = null;
        this.processingPromise = null;
        this.currentStatus = '切断済み';
        this.currentTaskLabel = '接続が破棄されました';
        this.cycleStartedAt = null;
        void this.clearStatusMessage();

        return true;
    }

    /**
     * 録音を停止する
     */
    async stopRecording(skipFinal: boolean = false, destroyConnection: boolean = true): Promise<void> {
        if (this.isStopping) {
            await this.processingPromise?.catch(() => undefined);
            return;
        }

        this.isStopping = true;
        this.isProcessLoopRunning = false;
        this.resolveProcessLoopWait();
        this.currentStatus = skipFinal ? '停止処理中' : '最終分析中';
        this.currentTaskLabel = skipFinal ? '録音を停止しています' : '終了前の最終分析を準備しています';
        await this.refreshStatusMessage();

        const activeConnection = this.voiceConnection;
        const shouldRunFinal = !skipFinal && !!this.recorder;
        this.detachFromVoiceCapture();
        this.logVoiceStats(skipFinal ? 'stop_without_final' : 'stop_with_final');
        this.isRecording = false;

        if (activeConnection) {
            // 先にセッション参照を外しておくと、共有接続の active 判定に残骸が残りにくい。
            this.voiceConnection = null;
            if (destroyConnection && activeConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                activeConnection.destroy();
            }
        }

        try {
            // 既存の periodic/manual 分析が残っていたら、ここで終わるのを待つ。
            await this.waitForBackgroundActivity();

            if (shouldRunFinal && this.recorder) {
                if (this.targetTextChannel) {
                    await this.targetTextChannel.send("🔄 終了前の最終分析を行っています...しばらくお待ちください。");
                }
                await this.processAudio(false, true);
            }

            this.isProcessingAudio = false;
            this.cycleStartedAt = null;
            this.currentStatus = '停止中';
            this.currentTaskLabel = '録音は停止しています';
            this.recorder = null;
            await this.clearStatusMessage();
        } finally {
            this.isStopping = false;
        }
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

    private async clearStatusMessage(): Promise<void> {
        // 実際の Discord message 編集は LiveVoiceStatusDisplay が担当する。
        // セッション側では状態変数だけを更新し、このメソッド自体は no-op として残す。
    }

    private async replaceStatusMessage(): Promise<void> {
        await this.refreshStatusMessage();
    }

    private async refreshStatusMessage(_afterMessage?: any, force: boolean = false): Promise<void> {
        void _afterMessage;
        void force;
    }

    /**
     * 定期分析ループ
     */
    private async processLoop(): Promise<void> {
        while (this.isProcessLoopRunning) {
            this.cycleStartedAt = Date.now();
            this.currentStatus = '録音中';
            this.currentTaskLabel = '次回の自動分析を待機中';
            await this.refreshStatusMessage(undefined, true);

            while (this.isProcessLoopRunning) {
                try {
                    this.settings = getGuildSettings(this.guildId);
                    const remainingSeconds = this.getRemainingSeconds();
                    await this.refreshStatusMessage();

                    if (remainingSeconds !== null && remainingSeconds <= 0) {
                        break;
                    }

                    await this.waitForProcessLoopTick();
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
        const recorder = this.recorder;
        if (!recorder || (!this.isRecording && !isFinal)) return;
        if (this.processingPromise) {
            await this.processingPromise.catch(() => undefined);
            return;
        }

        let runPromise: Promise<void>;
        runPromise = this.runProcessAudio(recorder, isManual, isFinal)
            .finally(() => {
                if (this.processingPromise === runPromise) {
                    this.processingPromise = null;
                }
            });
        this.processingPromise = runPromise;
        await runPromise;
    }

    private async runProcessAudio(
        recorder: UserAudioRecorder,
        isManual: boolean = false,
        isFinal: boolean = false
    ): Promise<void> {
        this.isProcessingAudio = true;

        const jobName = isManual ? 'Manual analysis' : 'Periodic analysis';
        console.log(`[${this.guildId}] Starting ${jobName}...`);

        try {
            this.currentStatus = isFinal ? '最終分析中' : isManual ? '手動分析中' : '自動分析中';
            this.currentTaskLabel = '音声を確定しています';
            await this.refreshStatusMessage(undefined, true);

            const userFilesRaw = await recorder.flushAudio();

            if (userFilesRaw.size === 0) {
                if (isFinal || !this.isRecording) {
                    this.currentStatus = '停止中';
                    this.currentTaskLabel = '録音は停止しています';
                    await this.clearStatusMessage();
                } else {
                    this.currentStatus = '録音中';
                    this.currentTaskLabel = isManual ? '新しい音声がなかったため待機中' : '次回の自動分析を待機中';
                    await this.refreshStatusMessage(undefined, true);
                }
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
            await this.refreshStatusMessage(undefined, true);

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
                await this.refreshStatusMessage(undefined, true);
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
                await this.refreshStatusMessage(undefined, true);

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
                if (!isFinal) {
                    this.currentStatus = this.isRecording ? '録音中' : '停止中';
                    this.currentTaskLabel = this.isRecording
                        ? '次回の自動分析を待機中'
                        : '録音は停止しています';
                    await this.replaceStatusMessage();
                } else {
                    await this.clearStatusMessage();
                }
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
            if (this.targetTextChannel) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                await this.targetTextChannel.send(`⚠️ 分析処理中にエラーが発生しました: ${errorMessage}`);
            }
        } finally {
            this.isProcessingAudio = false;

            if (this.isRecording && this.isProcessLoopRunning) {
                this.currentStatus = '録音中';
                this.currentTaskLabel = '次回の自動分析を待機中';
                if (!isManual && !isFinal) {
                    this.cycleStartedAt = Date.now();
                }
            } else if (this.isRecording && !isFinal) {
                this.currentStatus = '録音中';
                this.currentTaskLabel = '待機中';
            } else {
                this.currentStatus = '停止中';
                this.currentTaskLabel = '録音は停止しています';
                this.cycleStartedAt = null;
            }

            if (isFinal || !this.isRecording) {
                await this.clearStatusMessage();
            } else {
                await this.refreshStatusMessage(undefined, true);
            }
        }
    }

    private async waitForBackgroundActivity(): Promise<void> {
        if (this.processLoopPromise) {
            await this.processLoopPromise.catch(() => undefined);
        }
        if (this.processingPromise) {
            await this.processingPromise.catch(() => undefined);
        }
    }

    private async waitForProcessLoopTick(): Promise<void> {
        await new Promise<void>((resolve) => {
            // stop 時はこの待機を即解除して、次の periodic cycle に入らせない。
            const timeout = setTimeout(() => {
                if (this.processLoopWaitResolver === wake) {
                    this.processLoopWaitResolver = null;
                }
                resolve();
            }, 5000);

            const wake = () => {
                clearTimeout(timeout);
                if (this.processLoopWaitResolver === wake) {
                    this.processLoopWaitResolver = null;
                }
                resolve();
            };

            this.processLoopWaitResolver = wake;
        });
    }

    private resolveProcessLoopWait(): void {
        const resolver = this.processLoopWaitResolver;
        this.processLoopWaitResolver = null;
        resolver?.();
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

    getExistingSession(guildId: string): GuildSession | null {
        return this.sessions.get(guildId) || null;
    }

    listSessionGuildIds(): string[] {
        return Array.from(this.sessions.keys());
    }

    async cleanupSession(
        guildId: string,
        skipFinal: boolean = false,
        destroyConnection: boolean = true
    ): Promise<void> {
        if (this.sessions.has(guildId)) {
            await this.sessions.get(guildId)!.stopRecording(skipFinal, destroyConnection);
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
