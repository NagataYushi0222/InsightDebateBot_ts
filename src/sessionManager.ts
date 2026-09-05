import {
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import fs from 'fs';
import path from 'path';
import { Client, TextChannel, Guild, Message } from 'discord.js';
import { UserAudioRecorder } from './recorder';
import { cleanupFiles } from './audioProcessor';
import { analyzeDiscussion, StructuredDiscussionMemory } from './analyzer';
import { getGeminiModelDisplayName, resolveGeminiModel, TEMP_AUDIO_DIR } from './config';
import { getGuildSettings, GuildSettings } from './database';
import { attachVoiceCaptureConsumer } from './voiceCaptureHub';
import type { VoiceConsumerDiagnosticsSnapshot } from './voiceDiagnostics';

type StatusAnchorHandler = (guildId: string, message: Message) => Promise<void> | void;

export interface AnalyzeSessionStartOptions {
    apiKey?: string | null;
    voiceChannelName?: string;
    analysisMode?: string;
    dialogueTheme?: string | null;
}

export interface AnalyzeStatusSummary {
    status: string;
    task: string;
    remainingSeconds: number | null;
    mode: string;
    dialogueTheme: string | null;
    retainedAudioSegmentCount: number;
    retainedAudioUserCount: number;
    retainedAudioIncludedInCurrentReport: boolean;
    retainedAudioIncludedSegmentCount: number;
}

interface PreparedAudioBatch {
    analysisRawFiles: Map<string, string>;
    sourceRawFilesByUser: Map<string, string[]>;
    sourceRawFiles: string[];
    generatedRawFiles: string[];
    hadRetainedAudio: boolean;
    retainedSegmentCount: number;
}

/**
 * ギルドごとのセッション
 */
export class GuildSession {
    public guildId: string;
    private bot: Client;
    public voiceConnection: VoiceConnection | null = null;
    private recorder: UserAudioRecorder | null = null;
    public targetTextChannel: TextChannel | null = null;
    private structuredMemory: StructuredDiscussionMemory | null = null;
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
    private statusAnchorHandler: StatusAnchorHandler | null = null;
    private activeAnalysisMode: string = 'debate';
    private activeDialogueTheme: string | null = null;
    private retainedRawAudioFiles: Map<string, string[]> = new Map();
    private retainedAudioIncludedInCurrentReport: boolean = false;
    private retainedAudioIncludedSegmentCount: number = 0;

    constructor(guildId: string, bot: Client) {
        this.guildId = guildId;
        this.bot = bot;
        this.settings = getGuildSettings(guildId);
        this.consumerLabel = `analyze:${guildId}`;
    }

    setStatusAnchorHandler(handler: StatusAnchorHandler | null): void {
        this.statusAnchorHandler = handler;
    }

    /**
     * 録音を開始する
     */
    async startRecording(
        connection: VoiceConnection,
        channel: TextChannel,
        options: AnalyzeSessionStartOptions = {},
    ): Promise<void> {
        const {
            apiKey = null,
            voiceChannelName = 'Voice Channel',
            analysisMode,
            dialogueTheme = null,
        } = options;

        this.voiceConnection = connection;
        this.targetTextChannel = channel;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;
        this.apiKey = apiKey;
        this.voiceChannelName = voiceChannelName;
        this.settings = getGuildSettings(this.guildId);
        this.activeAnalysisMode = analysisMode || this.settings.analysis_mode || 'debate';
        this.activeDialogueTheme = this.activeAnalysisMode === 'dialogue'
            ? (dialogueTheme?.trim() || null)
            : null;
        this.lastVoiceStats = null;
        this.cycleStartedAt = Date.now();
        this.currentStatus = '録音中';
        this.currentTaskLabel = '次回の自動分析を待機中';
        await this.refreshStatusMessage(undefined, true);
        this.detachFromVoiceCapture();
        this.detachVoiceCapture = attachVoiceCaptureConsumer(connection, {
            consumerLabel: this.consumerLabel,
            onOpus: (userId, opusPacket) => {
                if (!this.isRecording || !this.recorder) return;
                this.recorder.writeOpus(userId, opusPacket);
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

    /**
     * 一時的な切断から復帰するため、新しい VoiceConnection を再アタッチする。
     * structuredMemory・録音サイクル・APIキーなどはそのまま維持し、
     * 音声キャプチャだけ新しい接続へ切り替える。
     */
    reattachVoiceConnection(connection: VoiceConnection): void {
        this.voiceConnection = connection;
        this.detachFromVoiceCapture();
        this.detachVoiceCapture = attachVoiceCaptureConsumer(connection, {
            consumerLabel: this.consumerLabel,
            onOpus: (userId, opusPacket) => {
                if (!this.isRecording || !this.recorder) return;
                this.recorder.writeOpus(userId, opusPacket);
            },
            onStats: (stats) => {
                this.lastVoiceStats = stats;
            },
        });
    }

    /**
     * 再接続に先立ち、古い VoiceConnection の参照とキャプチャ購読を解放する。
     * isRecording やメモリは維持したまま、sharedVoiceCoordinator が
     * 「active な接続がない」と判定できるようにする。
     */
    prepareForReconnect(): void {
        this.detachFromVoiceCapture();
        this.voiceConnection = null;
    }

    isStoppingInProgress(): boolean {
        return this.isStopping;
    }

    hasRetainedAudio(): boolean {
        return this.getRetainedAudioSegmentCount() > 0;
    }

    adoptRetainedRawAudioFiles(retainedRawAudioFiles: Map<string, string[]>): void {
        this.discardRetainedRawAudioFiles();
        this.retainedRawAudioFiles = new Map(
            Array.from(retainedRawAudioFiles.entries())
                .map(([userId, files]) => [
                    userId,
                    files.filter((filePath) => fs.existsSync(filePath)),
                ] as [string, string[]])
                .filter(([, files]) => files.length > 0),
        );
    }

    takeRetainedRawAudioFiles(): Map<string, string[]> {
        const retained = this.retainedRawAudioFiles;
        this.retainedRawAudioFiles = new Map();
        return retained;
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
        this.activeDialogueTheme = null;
        this.discardRetainedRawAudioFiles();
        this.retainedAudioIncludedInCurrentReport = false;
        this.retainedAudioIncludedSegmentCount = 0;
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

            if (skipFinal) {
                this.discardRetainedRawAudioFiles();
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

    getStatusSummary(): AnalyzeStatusSummary {
        return {
            status: this.currentStatus,
            task: this.currentTaskLabel,
            remainingSeconds: this.getRemainingSeconds(),
            mode: this.activeAnalysisMode,
            dialogueTheme: this.activeDialogueTheme,
            retainedAudioSegmentCount: this.getRetainedAudioSegmentCount(),
            retainedAudioUserCount: this.retainedRawAudioFiles.size,
            retainedAudioIncludedInCurrentReport: this.retainedAudioIncludedInCurrentReport,
            retainedAudioIncludedSegmentCount: this.retainedAudioIncludedSegmentCount,
        };
    }

    async syncSettingsAndStatus(): Promise<void> {
        this.settings = getGuildSettings(this.guildId);
        await this.refreshStatusMessage();
    }

    getActiveAnalysisMode(): string {
        return this.activeAnalysisMode;
    }

    getDialogueTheme(): string | null {
        return this.activeDialogueTheme;
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

    private getRetainedAudioSegmentCount(): number {
        let count = 0;
        for (const files of this.retainedRawAudioFiles.values()) {
            count += files.length;
        }
        return count;
    }

    private discardRetainedRawAudioFiles(): void {
        const retainedFiles = Array.from(this.retainedRawAudioFiles.values()).flat();
        cleanupFiles(retainedFiles);
        this.retainedRawAudioFiles.clear();
    }

    private retainRawAudioFiles(sourceRawFilesByUser: Map<string, string[]>): void {
        this.retainedRawAudioFiles = new Map(
            Array.from(sourceRawFilesByUser.entries())
                .map(([userId, files]) => [
                    userId,
                    files.filter((filePath) => fs.existsSync(filePath)),
                ] as [string, string[]])
                .filter(([, files]) => files.length > 0),
        );
    }

    private clearRetainedRawAudioReferences(): void {
        this.retainedRawAudioFiles.clear();
    }

    private resetRetainedAudioProcessingMarker(): void {
        this.retainedAudioIncludedInCurrentReport = false;
        this.retainedAudioIncludedSegmentCount = 0;
    }

    private async concatenateRawAudioFiles(filePaths: string[], outputPath: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            let settled = false;
            let index = 0;

            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                output.destroy();
                reject(error);
            };

            const pipeNext = () => {
                if (settled) return;
                if (index >= filePaths.length) {
                    output.end();
                    return;
                }

                const input = fs.createReadStream(filePaths[index++]);
                input.once('error', fail);
                input.once('end', pipeNext);
                input.pipe(output, { end: false });
            };

            output.once('error', fail);
            output.once('finish', () => {
                if (settled) return;
                settled = true;
                resolve();
            });

            pipeNext();
        });
    }

    private buildSourceRawFilesByUser(currentRawFiles: Map<string, string>): Map<string, string[]> {
        const sourceRawFilesByUser = new Map<string, string[]>();

        const appendRawFile = (userId: string, filePath: string) => {
            if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
                return;
            }
            const files = sourceRawFilesByUser.get(userId) || [];
            if (!files.includes(filePath)) {
                files.push(filePath);
            }
            sourceRawFilesByUser.set(userId, files);
        };

        for (const [userId, files] of this.retainedRawAudioFiles.entries()) {
            for (const filePath of files) {
                appendRawFile(userId, filePath);
            }
        }

        for (const [userId, filePath] of currentRawFiles.entries()) {
            appendRawFile(userId, filePath);
        }

        return sourceRawFilesByUser;
    }

    private async prepareAudioBatch(currentRawFiles: Map<string, string>): Promise<PreparedAudioBatch> {
        const sourceRawFilesByUser = this.buildSourceRawFilesByUser(currentRawFiles);
        const retainedSegmentCount = this.getRetainedAudioSegmentCount();

        const analysisRawFiles = new Map<string, string>();
        const generatedRawFiles: string[] = [];

        for (const [userId, files] of sourceRawFilesByUser.entries()) {
            // Oggコンテナはバイト連結できないため、再試行分も独立したGemini音声Partとして渡す。
            files.forEach((filePath, index) => analysisRawFiles.set(
                files.length === 1 ? userId : `${userId}__part${index + 1}`,
                filePath,
            ));
        }

        return {
            analysisRawFiles,
            sourceRawFilesByUser,
            sourceRawFiles: Array.from(sourceRawFilesByUser.values()).flat(),
            generatedRawFiles,
            hadRetainedAudio: retainedSegmentCount > 0,
            retainedSegmentCount,
        };
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
        let latestRawFilesForRetention: Map<string, string> | null = null;

        try {
            this.currentStatus = isFinal ? '最終分析中' : isManual ? '手動分析中' : '自動分析中';
            this.currentTaskLabel = '音声を確定しています';
            await this.refreshStatusMessage(undefined, true);

            const userFilesRaw = await recorder.flushAudio();
            latestRawFilesForRetention = userFilesRaw;

            if (userFilesRaw.size === 0 && !this.hasRetainedAudio()) {
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

            const audioBatch = await this.prepareAudioBatch(userFilesRaw);
            this.retainedAudioIncludedInCurrentReport = audioBatch.hadRetainedAudio;
            this.retainedAudioIncludedSegmentCount = audioBatch.retainedSegmentCount;

            if (audioBatch.hadRetainedAudio) {
                console.log(
                    `[${this.guildId}] Including ${audioBatch.retainedSegmentCount} retained audio segment(s) in this report.`,
                );
            }

            if (audioBatch.analysisRawFiles.size === 0) {
                this.retainRawAudioFiles(audioBatch.sourceRawFilesByUser);
                cleanupFiles(audioBatch.generatedRawFiles);
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

            for (const userId of audioBatch.analysisRawFiles.keys()) {
                const discordUserId = userId.split('__part')[0];
                let displayName = `User_${discordUserId}`;

                if (guild) {
                    const member = guild.members.cache.get(discordUserId);
                    if (member) {
                        displayName = member.displayName;
                    } else {
                        try {
                            const fetchedMember = await guild.members.fetch(discordUserId);
                            displayName = fetchedMember.displayName;
                        } catch {
                            try {
                                const user = await this.bot.users.fetch(discordUserId);
                                displayName = user.displayName;
                            } catch {
                                // keep default
                            }
                        }
                    }
                }

                userMap.set(userId, displayName);
            }

            // Ogg/Opus は再エンコードせず、そのまま Gemini File API へ渡す。
            const userFilesOgg = new Map<string, string>();
            const filesToCleanup: string[] = [...audioBatch.generatedRawFiles];
            let reportPosted = false;
            this.currentTaskLabel = audioBatch.hadRetainedAudio
                ? `前回未出力の音声 ${audioBatch.retainedSegmentCount} 件を含めてエンコード中`
                : 'エンコード中';
            await this.refreshStatusMessage(undefined, true);

await Promise.all(
                Array.from(audioBatch.analysisRawFiles.entries()).map(async ([userId, rawPath]) => {
                    userFilesOgg.set(userId, rawPath);
                }),
            );

            if (userFilesOgg.size !== audioBatch.analysisRawFiles.size) {
                this.retainRawAudioFiles(audioBatch.sourceRawFilesByUser);
                cleanupFiles(filesToCleanup);
                if (this.targetTextChannel) {
                    await this.targetTextChannel.send('⚠️ 音声ファイルの一部をエンコードできなかったため、今回の音声は次回レポートへ繰り越します。');
                }
                return;
            }

                 // スレッドの作成とレポート送信
            const now = new Date();
            // JST (UTC+9) への変換処理
            now.setHours(now.getUTCHours() + 9);
            const timestampStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

            const isDialogueMode = this.activeAnalysisMode === 'dialogue';
            let threadName = `${isDialogueMode ? '対話レポート' : '議論分析レポート'} ${timestampStr}`;
            let headerPrefix = isDialogueMode ? '💬 **対話レポート**' : '📊 **議論分析レポート**';
            if (isFinal) {
                threadName = `${isDialogueMode ? '対話レポート' : '議論分析レポート'} (最終) ${timestampStr}`;
                headerPrefix = isDialogueMode ? '🏁 **最終対話レポート**' : '🏁 **最終分析レポート**';
            } else if (isManual) {
                threadName = `${isDialogueMode ? '手動対話レポート' : '手動分析レポート'} ${timestampStr}`;
                headerPrefix = isDialogueMode ? '🚀 **手動対話レポート**' : '🚀 **手動分析レポート**';
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
                const analysisResult = await analyzeDiscussion(
                    userFilesOgg,
                    this.structuredMemory,
                    userMap,
                    apiKeyToUse,
                    this.activeAnalysisMode,
                    this.settings.model_name,
                    this.activeDialogueTheme,
                );
                const report = analysisResult.report;
                const usedModelName = analysisResult.modelName || resolveGeminiModel(this.settings.model_name);
                const usedModelDisplayName = getGeminiModelDisplayName(usedModelName);

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

                this.currentTaskLabel = 'レポート投稿中';
                await this.refreshStatusMessage(undefined, true);

                let titleText = isDialogueMode ? `💬 対話レポート (${timestampStr})` : `📅 自動分析 (${timestampStr})`;
                let embedColor = 0x3498db; // Blue
                if (isFinal) {
                    titleText = isDialogueMode ? `🛑 対話セッション終了 (${timestampStr})` : `🛑 セッション終了 (${timestampStr})`;
                    embedColor = 0xe74c3c; // Red
                } else if (isManual) {
                    titleText = isDialogueMode ? `💬 手動対話レポート (${timestampStr})` : `📅 手動分析 (${timestampStr})`;
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
                if (!isFinal && this.isRecording && this.statusAnchorHandler) {
                    await this.statusAnchorHandler(this.guildId, starterMsg);
                }
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
                const carryOverHeader = audioBatch.hadRetainedAudio
                    ? `🔁 **繰り越し音声**: 前回未出力の音声 ${audioBatch.retainedSegmentCount} 件を含めています\n`
                    : '';
                const header = `${headerPrefix}\n🤖 **使用モデル**: ${usedModelDisplayName} (\`${usedModelName}\`)\n${carryOverHeader}\n`;
                if (report.length + header.length < 2000) {
                    await reportThread.send(header + report);
                } else {
                    await reportThread.send(header);
                    for (let i = 0; i < report.length; i += 1900) {
                        await reportThread.send(report.slice(i, i + 1900));
                    }
                }

                // 次回用の文脈は、Discord へレポートを出せたあとでだけ更新する。
                this.structuredMemory = analysisResult.memory;
                reportPosted = true;
            } catch (e) {
                console.error(`[${this.guildId}] Error in reporting:`, e);
                if (this.targetTextChannel) {
                    await this.targetTextChannel.send(`⚠️ エラー: ${e}`);
                }
            } finally {
                cleanupFiles(filesToCleanup);
                if (reportPosted) {
                    cleanupFiles(audioBatch.sourceRawFiles);
                    this.clearRetainedRawAudioReferences();
                } else {
                    this.retainRawAudioFiles(audioBatch.sourceRawFilesByUser);
                    if (this.targetTextChannel) {
                        await this.targetTextChannel.send('🔁 レポートを出力できなかった音声を保持しました。次回のレポート生成時に一緒に分析します。');
                    }
                }
            }
        } catch (e) {
            if (latestRawFilesForRetention) {
                this.retainRawAudioFiles(this.buildSourceRawFilesByUser(latestRawFilesForRetention));
            }
            console.error(`[${this.guildId}] Error in processAudio:`, e);
            if (this.targetTextChannel) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                await this.targetTextChannel.send(`⚠️ 分析処理中にエラーが発生しました: ${errorMessage}`);
                if (this.hasRetainedAudio()) {
                    await this.targetTextChannel.send('🔁 レポートを出力できなかった音声を保持しました。次回のレポート生成時に一緒に分析します。');
                }
            }
        } finally {
            this.isProcessingAudio = false;
            this.resetRetainedAudioProcessingMarker();

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
    private retainedRawAudioByGuild: Map<string, Map<string, string[]>> = new Map();
    private statusAnchorHandler: StatusAnchorHandler | null = null;

    constructor(bot: Client) {
        this.bot = bot;
    }

    getSession(guildId: string): GuildSession {
        if (!this.sessions.has(guildId)) {
            const session = new GuildSession(guildId, this.bot);
            session.setStatusAnchorHandler(this.statusAnchorHandler);
            const retainedRawAudioFiles = this.retainedRawAudioByGuild.get(guildId);
            if (retainedRawAudioFiles) {
                session.adoptRetainedRawAudioFiles(retainedRawAudioFiles);
                this.retainedRawAudioByGuild.delete(guildId);
            }
            this.sessions.set(guildId, session);
        }
        return this.sessions.get(guildId)!;
    }

    getExistingSession(guildId: string): GuildSession | null {
        return this.sessions.get(guildId) || null;
    }

    listSessionGuildIds(): string[] {
        return Array.from(this.sessions.keys());
    }

    setStatusAnchorHandler(handler: StatusAnchorHandler | null): void {
        this.statusAnchorHandler = handler;
        for (const session of this.sessions.values()) {
            session.setStatusAnchorHandler(handler);
        }
    }

    async cleanupSession(
        guildId: string,
        skipFinal: boolean = false,
        destroyConnection: boolean = true
    ): Promise<void> {
        if (this.sessions.has(guildId)) {
            const session = this.sessions.get(guildId)!;
            await session.stopRecording(skipFinal, destroyConnection);
            if (session.hasRetainedAudio()) {
                this.retainedRawAudioByGuild.set(guildId, session.takeRetainedRawAudioFiles());
            } else {
                this.retainedRawAudioByGuild.delete(guildId);
            }
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
