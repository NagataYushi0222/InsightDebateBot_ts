import { VoiceConnection, VoiceConnectionStatus } from '@ovencord/voice';
import { ChannelType, Client, PermissionFlagsBits, TextChannel } from 'discord.js';
import { LiveVoiceStatusDisplay } from './liveVoiceStatusDisplay';
import { SessionManager } from './sessionManager';
import { VcArticleSessionManager } from './vcArticle/sessionManager';

export interface VoiceDisconnectReport {
    guildId: string;
    connection: VoiceConnection | null;
    reason: string;
    detail?: string;
    fallbackTextChannel?: TextChannel | null;
}

export class VoiceDisconnectReporter {
    private readonly reportedConnections = new WeakSet<VoiceConnection>();

    constructor(
        private readonly client: Client,
        private readonly sessionManager: SessionManager,
        private readonly liveVoiceStatusDisplay: LiveVoiceStatusDisplay,
        private readonly vcArticleManager: VcArticleSessionManager | null = null,
    ) {}

    async report({
        guildId,
        connection,
        reason,
        detail,
        fallbackTextChannel = null,
    }: VoiceDisconnectReport): Promise<void> {
        if (connection && this.reportedConnections.has(connection)) {
            await this.liveVoiceStatusDisplay.deleteMonitor(guildId);
            return;
        }

        if (connection) {
            this.reportedConnections.add(connection);
        }

        const channels = this.resolveTextChannels(guildId, connection, fallbackTextChannel);
        const message = this.buildDisconnectMessage(guildId, connection, reason, detail);

        let sentCount = await this.sendToChannels(channels, message);
        let fallbackChannel: TextChannel | null = null;
        if (sentCount === 0) {
            const candidateFallback = this.resolveFallbackGuildTextChannel(guildId);
            fallbackChannel = candidateFallback;
            if (candidateFallback && !channels.some((channel) => channel.id === candidateFallback.id)) {
                sentCount += await this.sendToChannels([candidateFallback], message);
            }
        }

        if (sentCount === 0 && channels.length === 0 && !fallbackChannel) {
            console.warn(
                `[Voice Disconnect] guild=${guildId} reason=${reason} no text channel available for notification`,
            );
        }

        await this.liveVoiceStatusDisplay.deleteMonitor(guildId);
    }

    async reportBeforeDestroy(report: VoiceDisconnectReport): Promise<void> {
        await this.report(report);
        this.destroyIfActive(report.connection);
    }

    /**
     * 指定した接続の切断通知を抑制する。
     * 自動再接続成功時など、古い接続が破棄されても切断メッセージを出したくない場合に使う。
     */
    suppressReport(connection: VoiceConnection): void {
        if (connection) {
            this.reportedConnections.add(connection);
        }
    }

    private destroyIfActive(connection: VoiceConnection | null): void {
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
        }
    }

    private async sendToChannels(channels: TextChannel[], message: string): Promise<number> {
        const results = await Promise.all(channels.map(async (channel) => {
            return channel.send(message)
                .then(() => true)
                .catch((error) => {
                    console.error(
                        `[Voice Disconnect] Failed to send disconnect notice in channel ${channel.id}:`,
                        error,
                    );
                    return false;
                });
        }));

        return results.filter(Boolean).length;
    }

    private resolveTextChannels(
        guildId: string,
        connection: VoiceConnection | null,
        fallbackTextChannel: TextChannel | null,
    ): TextChannel[] {
        const channels = new Map<string, TextChannel>();

        const addChannel = (channel: TextChannel | null | undefined) => {
            if (channel) {
                channels.set(channel.id, channel);
            }
        };

        const analyzeSession = this.sessionManager.getExistingSession(guildId);
        if (
            analyzeSession?.targetTextChannel
            && (
                !connection
                || analyzeSession.voiceConnection === connection
                || analyzeSession.isBusy()
            )
        ) {
            addChannel(analyzeSession.targetTextChannel);
        }

        const articleSession = this.vcArticleManager?.getExistingSession(guildId) || null;
        if (
            articleSession?.targetTextChannel
            && (
                !connection
                || articleSession.voiceConnection === connection
                || articleSession.isBusy()
            )
        ) {
            addChannel(articleSession.targetTextChannel);
        }

        addChannel(fallbackTextChannel);

        if (channels.size === 0) {
            addChannel(this.resolveFallbackGuildTextChannel(guildId));
        }

        return Array.from(channels.values());
    }

    private resolveFallbackGuildTextChannel(guildId: string): TextChannel | null {
        const guild = this.client.guilds.cache.get(guildId);
        const botMember = guild?.members.me || null;
        if (!guild || !botMember) {
            return null;
        }

        const systemChannel = guild.systemChannel;
        if (
            systemChannel
            && systemChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)
        ) {
            return systemChannel;
        }

        for (const channel of guild.channels.cache.values()) {
            if (channel.type !== ChannelType.GuildText) {
                continue;
            }
            if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
                continue;
            }
            return channel;
        }

        return null;
    }

    private buildDisconnectMessage(
        guildId: string,
        connection: VoiceConnection | null,
        reason: string,
        detail?: string,
    ): string {
        const guild = this.client.guilds.cache.get(guildId);
        const channelId = connection?.joinConfig.channelId || null;
        const voiceChannelName = channelId
            ? guild?.channels.cache.get(channelId)?.name || channelId
            : '不明';
        const lines = [
            '🔌 **VCから切断しました**',
            `理由: ${reason}`,
            `対象VC: **${voiceChannelName}**`,
        ];

        if (detail) {
            lines.push(`詳細: ${detail}`);
        }

        return lines.join('\n');
    }
}
