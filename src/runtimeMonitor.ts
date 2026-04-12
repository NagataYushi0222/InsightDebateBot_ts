import { Client } from 'discord.js';
import { VoiceConnectionStatus } from '@ovencord/voice';
import { SessionManager } from './sessionManager';
import { SharedVoiceCoordinator } from './sharedVoiceCoordinator';
import { VcArticleSessionManager } from './vcArticle/sessionManager';

const RUNTIME_WATCH_INTERVAL_MS = 30_000;

function formatMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export class RuntimeMonitor {
    private watchTimer: ReturnType<typeof setInterval> | null = null;
    private installed = false;

    constructor(
        private readonly client: Client,
        private readonly sessionManager: SessionManager,
        private readonly vcArticleManager: VcArticleSessionManager,
        private readonly sharedVoiceCoordinator: SharedVoiceCoordinator,
    ) {}

    start(): void {
        if (this.installed) {
            return;
        }

        this.installed = true;
        this.installProcessEventLogging();
        this.watchTimer = setInterval(() => {
            this.logActiveVoiceHealth();
        }, RUNTIME_WATCH_INTERVAL_MS);
        this.watchTimer.unref?.();
    }

    stop(): void {
        if (this.watchTimer) {
            clearInterval(this.watchTimer);
            this.watchTimer = null;
        }
    }

    logBotVoiceStateChange(guildId: string, oldChannelId: string | null, newChannelId: string | null): void {
        const guild = this.client.guilds.cache.get(guildId);
        const oldChannelName = oldChannelId ? guild?.channels.cache.get(oldChannelId)?.name || oldChannelId : 'none';
        const newChannelName = newChannelId ? guild?.channels.cache.get(newChannelId)?.name || newChannelId : 'none';
        const activeConnection = this.sharedVoiceCoordinator.getActiveGuildVoiceConnection(guildId);

        console.log(
            [
                '[Runtime Monitor][Bot Voice State]',
                `guild=${guildId}`,
                `old_channel=${oldChannelName}`,
                `new_channel=${newChannelName}`,
                `active_connection=${activeConnection?.state.status || 'none'}`,
            ].join(' '),
        );
    }

    logSessionCleanup(reason: string, guildId: string): void {
        console.log(`[Runtime Monitor][Cleanup] guild=${guildId} reason=${reason}`);
    }

    private installProcessEventLogging(): void {
        process.on('uncaughtException', (error) => {
            console.error('[Runtime Monitor][Process] uncaughtException:', error);
        });
        process.on('unhandledRejection', (reason) => {
            console.error('[Runtime Monitor][Process] unhandledRejection:', reason);
        });
        process.on('beforeExit', (code) => {
            console.log(`[Runtime Monitor][Process] beforeExit code=${code}`);
        });
        process.on('exit', (code) => {
            console.log(`[Runtime Monitor][Process] exit code=${code}`);
        });
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
            process.on(signal, () => {
                console.warn(`[Runtime Monitor][Process] received ${signal}`);
            });
        }
    }

    private logActiveVoiceHealth(): void {
        const guildIds = new Set<string>([
            ...this.sessionManager.listSessionGuildIds(),
            ...this.vcArticleManager.listSessionGuildIds(),
        ]);

        for (const guild of this.client.guilds.cache.values()) {
            if (guild.members.me?.voice.channelId) {
                guildIds.add(guild.id);
            }
        }

        if (guildIds.size === 0) {
            return;
        }

        const memory = process.memoryUsage();
        const uptimeSeconds = Math.floor(process.uptime());

        for (const guildId of guildIds) {
            const analyzeSession = this.sessionManager.getExistingSession(guildId);
            const articleSession = this.vcArticleManager.getExistingSession(guildId);
            const activeConnection = this.sharedVoiceCoordinator.getActiveGuildVoiceConnection(guildId);

            const analyzeActive = !!analyzeSession?.hasActiveConnection() && analyzeSession.isRecording;
            const articleActive = !!articleSession?.hasActiveConnection() && articleSession.isRecording;
            const guild = this.client.guilds.cache.get(guildId);
            const botVoiceChannelId = guild?.members.me?.voice.channelId || null;
            if (!analyzeActive && !articleActive && !activeConnection && !botVoiceChannelId) {
                continue;
            }

            const targetChannelId = activeConnection?.joinConfig.channelId || null;
            const targetChannel = targetChannelId ? guild?.channels.cache.get(targetChannelId) : null;
            const nonBotMembers = targetChannel?.isVoiceBased()
                ? targetChannel.members.filter((member) => !member.user.bot).size
                : 0;
            const botPresent = botVoiceChannelId === targetChannelId;
            const status = activeConnection?.state.status || 'none';
            const warning =
                activeConnection && (!botPresent || status === VoiceConnectionStatus.Destroyed)
                    ? ' warning=voice_state_mismatch'
                    : !activeConnection && botVoiceChannelId
                        ? ' warning=bot_in_channel_without_active_session'
                    : '';

            console.log(
                [
                    '[Runtime Monitor][Health]',
                    `guild=${guildId}`,
                    `analyze_active=${analyzeActive}`,
                    `article_active=${articleActive}`,
                    `connection_status=${status}`,
                    `target_channel=${targetChannelId || 'none'}`,
                    `bot_voice_channel=${botVoiceChannelId || 'none'}`,
                    `bot_present=${botPresent}`,
                    `non_bot_members=${nonBotMembers}`,
                    `rss=${formatMb(memory.rss)}`,
                    `heap_used=${formatMb(memory.heapUsed)}`,
                    `uptime_s=${uptimeSeconds}`,
                ].join(' ') + warning,
            );
        }
    }
}
