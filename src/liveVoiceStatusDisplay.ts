import { Client, Guild, Message } from 'discord.js';
import { VoiceConnection } from '@ovencord/voice';
import { SessionManager } from './sessionManager';
import { getVoiceConnectionLiveSnapshot, VoiceConnectionLiveSnapshot, VoiceLiveUserStats } from './voiceDiagnostics';
import { VcArticleSessionManager } from './vcArticle/sessionManager';

const STATUS_UPDATE_INTERVAL_MS = 10_000;
const MAX_STATUS_MESSAGE_LENGTH = 1_900;
const MAX_INLINE_TEXT_LENGTH = 80;
const MAX_SPEAKER_LINES = 3;

interface TrackedStatusMessage {
    anchorMessage: Message;
    monitorMessage: Message | null;
    lastContent: string;
    refreshChain: Promise<void>;
}

interface AnalyzeStatusSummary {
    status: string;
    task: string;
    remainingSeconds: number | null;
}

interface ArticleStatusSummary {
    status: string;
    task: string;
    pendingClipCount: number;
    textEntryCount: number;
    topicCount: number;
    activeArchiveId: string | null;
    activeArchiveLabel: string | null;
}

interface RenderedStatusPayload {
    content: string;
    keepTracking: boolean;
}

function formatRate(numerator: number, denominator: number): string {
    if (denominator <= 0) {
        return '0.00%';
    }

    return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRemaining(seconds: number | null): string {
    if (seconds === null) return '停止中';

    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTime(date: Date): string {
    return new Intl.DateTimeFormat('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
}

function truncateText(text: string, maxLength: number = MAX_INLINE_TEXT_LENGTH): string {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clampDiscordMessage(content: string): string {
    if (content.length <= MAX_STATUS_MESSAGE_LENGTH) {
        return content;
    }

    return `${content.slice(0, MAX_STATUS_MESSAGE_LENGTH - 18).trimEnd()}\n…(表示を省略しました)`;
}

/**
 * VC の接続状況やパケット統計を 10 秒ごとに 1 件のメッセージへ反映する。
 *
 * このクラスの役割は「Discord に見せる監視表示」だけに限定している。
 * 録音や分析そのものの状態管理は SessionManager / VcArticleSessionManager が持ち、
 * ここではそれらの状態を読み取って、人間が見やすい 1 枚のダッシュボード文字列へ整形する。
 *
 * 以前は analyze 側の SessionManager が自分で statusMessage を edit していたが、
 * 監視内容が増えると責務が混ざって読みづらくなるため、この専用ファイルへ切り出している。
 */
export class LiveVoiceStatusDisplay {
    private readonly trackedMessages = new Map<string, TrackedStatusMessage>();
    private updateTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly client: Client,
        private readonly sessionManager: SessionManager,
        private readonly vcArticleManager: VcArticleSessionManager | null = null,
    ) {}

    /**
     * 監視表示の定期更新を開始する。
     *
     * すでに起動済みなら何もしない。
     * 1 ギルドごとに個別タイマーを増やすのではなく、1 本のタイマーで全ギルドの tracked message を回す。
     */
    start(): void {
        if (this.updateTimer) {
            return;
        }

        this.updateTimer = setInterval(() => {
            for (const guildId of this.trackedMessages.keys()) {
                void this.refreshGuild(guildId);
            }
        }, STATUS_UPDATE_INTERVAL_MS);
        this.updateTimer.unref?.();
    }

    stop(): void {
        if (!this.updateTimer) {
            return;
        }

        clearInterval(this.updateTimer);
        this.updateTimer = null;
    }

    /**
     * これ以降の VC 状態表示に使うメッセージを登録する。
     *
     * slash command の開始・停止時や自動分析レポートの投稿後に、その「基準メッセージ」をここへ渡しておく。
     * すると、その直下に専用の VC 稼働モニターを 1 件だけ作り、以後はその monitor message を edit し続ける。
     *
     * もし新しい基準メッセージが来たら、古い monitor message は削除してから作り直す。
     * これにより、チャット欄には常に「最新の bot メッセージ + その直下のモニター」だけが残り、
     * 監視表示が上の方へ埋もれたり、無駄に増殖したりしないようにしている。
     */
    async bindMessage(guildId: string, anchorMessage: Message): Promise<void> {
        const existing = this.trackedMessages.get(guildId);
        const previousAnchorId = existing?.anchorMessage.id || null;
        const tracked: TrackedStatusMessage = existing || {
            anchorMessage,
            monitorMessage: null,
            lastContent: '',
            refreshChain: Promise.resolve(),
        };

        tracked.anchorMessage = anchorMessage;
        this.trackedMessages.set(guildId, tracked);
        this.start();

        tracked.refreshChain = tracked.refreshChain
            .then(async () => {
                const anchorChanged = tracked.monitorMessage === null
                    || previousAnchorId !== anchorMessage.id;

                if (!anchorChanged) {
                    return;
                }

                if (tracked.monitorMessage) {
                    await tracked.monitorMessage.delete().catch(() => undefined);
                }

                tracked.monitorMessage = await anchorMessage.channel.send({
                    content: '📡 **VC稼働モニター**\n更新準備中...',
                });
                tracked.lastContent = '';
                await this.runRefresh(guildId);
            })
            .catch((error) => {
                console.error(`[Live Status] Failed to bind monitor message for guild ${guildId}:`, error);
            });

        await tracked.refreshChain;
    }

    /**
     * 定期タイマーを待たずに、今すぐ 1 ギルド分の表示を更新する。
     *
     * 状態変化が大きい start / stop 直後に呼ぶと、10 秒待たずに画面へ反映できる。
     */
    refreshNow(guildId: string): void {
        void this.refreshGuild(guildId);
    }

    private async refreshGuild(guildId: string): Promise<void> {
        const tracked = this.trackedMessages.get(guildId);
        if (!tracked || !tracked.monitorMessage) {
            return;
        }

        tracked.refreshChain = tracked.refreshChain.then(() => this.runRefresh(guildId)).catch((error) => {
            console.error(`[Live Status] Failed to refresh guild ${guildId}:`, error);
        });

        await tracked.refreshChain;
    }

    /**
     * 実際の描画更新を 1 回だけ行う本体。
     *
     * refreshGuild() は「直列化のためのキュー投入」だけを担当し、
     * ここでは message.edit などの副作用だけを実行する。
     * こう分けておくと、bindMessage() の処理中に refreshGuild() を await したときに
     * 自分自身が積んだ Promise を再度待ってしまう自己デッドロックを避けられる。
     */
    private async runRefresh(guildId: string): Promise<void> {
        const tracked = this.trackedMessages.get(guildId);
        if (!tracked || !tracked.monitorMessage) {
            return;
        }

        const payload = this.buildContent(guildId);
        const nextContent = payload.content;

        if (tracked.lastContent !== nextContent) {
            try {
                await tracked.monitorMessage.edit({ content: nextContent });
                tracked.lastContent = nextContent;
            } catch (error) {
                console.error(`[Live Status] Failed to edit status message for guild ${guildId}:`, error);
                this.trackedMessages.delete(guildId);
                this.stopIfUnused();
                return;
            }
        }

        if (!payload.keepTracking) {
            this.trackedMessages.delete(guildId);
            this.stopIfUnused();
        }
    }

    private buildContent(guildId: string): RenderedStatusPayload {
        const guild = this.client.guilds.cache.get(guildId) || null;
        const analyzeSession = this.sessionManager.getExistingSession(guildId);
        const articleSession = this.vcArticleManager?.getExistingSession(guildId) || null;
        const analyzeSummary: AnalyzeStatusSummary = analyzeSession?.getStatusSummary() || {
            status: '停止中',
            task: '要約モードは待機しています',
            remainingSeconds: null,
        };
        const articleSummary: ArticleStatusSummary | null = articleSession?.getStatusSummary() || null;
        const connection = this.resolveVoiceConnection(guildId);
        const liveSnapshot = connection ? getVoiceConnectionLiveSnapshot(connection) : null;
        const targetChannelId =
            connection?.joinConfig.channelId
            || analyzeSession?.voiceConnection?.joinConfig.channelId
            || articleSession?.voiceConnection?.joinConfig.channelId
            || guild?.members.me?.voice.channelId
            || null;
        const targetChannelName = targetChannelId
            ? guild?.channels.cache.get(targetChannelId)?.name || targetChannelId
            : 'なし';
        const botVoiceChannelId = guild?.members.me?.voice.channelId || null;
        const botPresent = !!targetChannelId && botVoiceChannelId === targetChannelId;
        const connectionStatus = connection?.state.status || 'none';
        const keepTracking = this.shouldKeepTracking({
            analyzeSession,
            articleSession,
            connection,
            botPresent,
        });

        const lines = [
            '📡 **VC稼働モニター**',
            this.buildUpdateLine(keepTracking),
            `対象VC: **${truncateText(String(targetChannelName), 60)}**`,
            `接続状態: \`${connectionStatus}\` / Bot在室: \`${botPresent ? 'yes' : 'no'}\` / BotのVC: \`${botVoiceChannelId || 'none'}\``,
            `観測話者数: \`${liveSnapshot?.totals.userCount || 0}\``,
            '',
            '**要約モード**',
            `状態: \`${analyzeSummary.status}\``,
            `処理: ${truncateText(analyzeSummary.task, 120)}`,
            `次回レポートまで: \`${formatRemaining(analyzeSummary.remainingSeconds)}\``,
            '',
            ...(articleSummary ? this.buildArticleSection(articleSummary) : []),
            ...this.buildPacketSection(guildId, liveSnapshot),
            ...this.buildSpeakerSection(guild, liveSnapshot),
        ];

        return {
            content: clampDiscordMessage(lines.join('\n')),
            keepTracking,
        };
    }

    private buildArticleSection(articleSummary: ArticleStatusSummary): string[] {
        return [
            '**記事モード**',
            `状態: \`${articleSummary.status}\``,
            `処理: ${truncateText(articleSummary.task, 120)}`,
            `録音断片: \`${articleSummary.pendingClipCount}\` / 参考チャット: \`${articleSummary.textEntryCount}\` / 候補トピック: \`${articleSummary.topicCount}\``,
            `選択中アーカイブ: \`${articleSummary.activeArchiveId || 'none'}\``,
            `選択中タイトル: ${truncateText(articleSummary.activeArchiveLabel || 'なし', 100)}`,
            '',
        ];
    }

    private buildPacketSection(
        guildId: string,
        liveSnapshot: VoiceConnectionLiveSnapshot | null,
    ): string[] {
        if (!liveSnapshot) {
            return [
                '**受信統計**',
                '接続がないため、現在のパケット統計はありません。',
                '',
            ];
        }

        const totals = liveSnapshot.totals;
        const daveTotal = totals.daveDecryptSuccesses + totals.daveDecryptFailures;
        const analyzeConsumer = totals.pcmByConsumer[`analyze:${guildId}`] || {
            pcmPacketsDelivered: 0,
            pcmBytesDelivered: 0,
        };
        const articleConsumer = totals.pcmByConsumer[`article:${guildId}`] || {
            pcmPacketsDelivered: 0,
            pcmBytesDelivered: 0,
        };

        return [
            '**受信統計**',
            `Opus受信: \`${totals.opusPacketsReceived}\``,
            `DAVE復号: 成功 \`${totals.daveDecryptSuccesses}\` / 失敗 \`${totals.daveDecryptFailures}\` / 失敗率 \`${formatRate(totals.daveDecryptFailures, daveTotal)}\``,
            `Opusデコード失敗: \`${totals.opusDecodeFailures}\` / 失敗率 \`${formatRate(totals.opusDecodeFailures, totals.opusPacketsReceived)}\``,
            `PCM配信(要約): \`${analyzeConsumer.pcmPacketsDelivered}\` packets / \`${formatBytes(analyzeConsumer.pcmBytesDelivered)}\``,
            `PCM配信(記事): \`${articleConsumer.pcmPacketsDelivered}\` packets / \`${formatBytes(articleConsumer.pcmBytesDelivered)}\``,
            '',
        ];
    }

    private buildSpeakerSection(
        guild: Guild | null,
        liveSnapshot: VoiceConnectionLiveSnapshot | null,
    ): string[] {
        if (!liveSnapshot || liveSnapshot.users.length === 0) {
            return [
                '**話者別の状況**',
                'まだ話者ごとの統計はありません。',
            ];
        }

        const worstUsers = [...liveSnapshot.users]
            .sort((left, right) => {
                if (right.daveDecryptFailures !== left.daveDecryptFailures) {
                    return right.daveDecryptFailures - left.daveDecryptFailures;
                }
                if (right.opusDecodeFailures !== left.opusDecodeFailures) {
                    return right.opusDecodeFailures - left.opusDecodeFailures;
                }
                return right.opusPacketsReceived - left.opusPacketsReceived;
            })
            .slice(0, MAX_SPEAKER_LINES);

        const lines = ['**話者別の状況**'];

        for (const user of worstUsers) {
            lines.push(this.formatUserLine(guild, user));
        }

        return lines;
    }

    private formatUserLine(guild: Guild | null, user: VoiceLiveUserStats): string {
        const displayName = truncateText(
            guild?.members.cache.get(user.userId)?.displayName || `User_${user.userId}`,
            32,
        );
        const daveTotal = user.daveDecryptSuccesses + user.daveDecryptFailures;
        return [
            `- ${displayName}`,
            `DAVE失敗 \`${user.daveDecryptFailures}\` / 失敗率 \`${formatRate(user.daveDecryptFailures, daveTotal)}\` / Opus失敗 \`${user.opusDecodeFailures}\` / 受信 \`${user.opusPacketsReceived}\``,
        ].join(' ');
    }

    private buildUpdateLine(keepTracking: boolean): string {
        if (keepTracking) {
            return `最終更新: \`${formatTime(new Date())}\` / 自動更新: \`ON\``;
        }

        return `最終更新: \`${formatTime(new Date())}\` / 自動更新: \`OFF\``;
    }

    private shouldKeepTracking({
        analyzeSession,
        articleSession,
        connection,
        botPresent,
    }: {
        analyzeSession: ReturnType<SessionManager['getExistingSession']>;
        articleSession: { isBusy(): boolean } | null;
        connection: VoiceConnection | null;
        botPresent: boolean;
    }): boolean {
        return !!(
            analyzeSession?.isBusy()
            || articleSession?.isBusy()
            || connection
            || botPresent
        );
    }

    private resolveVoiceConnection(guildId: string): VoiceConnection | null {
        const analyzeSession = this.sessionManager.getExistingSession(guildId);
        if (analyzeSession?.voiceConnection && analyzeSession.hasActiveConnection()) {
            return analyzeSession.voiceConnection;
        }

        const articleSession = this.vcArticleManager?.getExistingSession(guildId) || null;
        if (articleSession?.voiceConnection && articleSession.hasActiveConnection()) {
            return articleSession.voiceConnection;
        }

        return null;
    }

    private stopIfUnused(): void {
        if (this.trackedMessages.size === 0) {
            this.stop();
        }
    }
}
