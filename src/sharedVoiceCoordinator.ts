import {
    entersState,
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import { Client, VoiceBasedChannel } from 'discord.js';
import { SessionManager } from './sessionManager';
import { VcArticleSessionManager } from './vcArticle/sessionManager';

interface ChannelActivityState {
    analyzeActive: boolean;
    articleActive: boolean;
    sharedConnection: boolean;
}

export class SharedVoiceCoordinator {
    private readonly managedVoiceConnections = new WeakSet<VoiceConnection>();

    constructor(
        private readonly client: Client,
        private readonly sessionManager: SessionManager,
        private readonly vcArticleManager: VcArticleSessionManager
    ) {}

    getActiveGuildVoiceConnection(guildId: string): VoiceConnection | null {
        const analyzeSession = this.sessionManager.getSession(guildId);
        if (analyzeSession.hasActiveConnection()) {
            return analyzeSession.voiceConnection;
        }

        const articleSession = this.vcArticleManager.getSession(guildId);
        if (articleSession.hasActiveConnection()) {
            return articleSession.voiceConnection;
        }

        return null;
    }

    shouldDestroyAnalyzeConnection(guildId: string): boolean {
        const { sharedConnection, articleActive } = this.getGuildActivityState(guildId);
        return !(sharedConnection && articleActive);
    }

    shouldDestroyArticleConnection(guildId: string): boolean {
        const { sharedConnection, analyzeActive } = this.getGuildActivityState(guildId);
        return !(sharedConnection && analyzeActive);
    }

    getChannelActivityState(guildId: string, channelId: string): ChannelActivityState {
        return this.buildActivityState(guildId, channelId);
    }

    async ensureVoiceConnectionForChannel(
        guildId: string,
        voiceChannel: VoiceBasedChannel,
        adapterCreator: Parameters<typeof joinVoiceChannel>[0]['adapterCreator']
    ): Promise<{ connection: VoiceConnection; reused: boolean }> {
        const existingConnection = this.getActiveGuildVoiceConnection(guildId);
        if (existingConnection) {
            if (existingConnection.joinConfig.channelId !== voiceChannel.id) {
                throw new Error(
                    'Bot は現在別のVCで録音中です。同じVCなら要約モードと記事化モードを同時に利用できます。'
                );
            }

            this.registerManagedVoiceConnection(guildId, existingConnection);
            await entersState(existingConnection, VoiceConnectionStatus.Ready, 30_000);
            this.seedVoiceParticipantsForConnection(guildId, existingConnection);
            return { connection: existingConnection, reused: true };
        }

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator,
            selfDeaf: false,
            debug: true,
        });

        this.registerManagedVoiceConnection(guildId, connection);
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        return { connection, reused: false };
    }

    private getGuildActivityState(guildId: string): ChannelActivityState {
        const activeConnection = this.getActiveGuildVoiceConnection(guildId);
        const channelId = activeConnection?.joinConfig.channelId;

        if (!channelId) {
            return {
                analyzeActive: false,
                articleActive: false,
                sharedConnection: false,
            };
        }

        return this.buildActivityState(guildId, channelId);
    }

    private buildActivityState(guildId: string, channelId: string): ChannelActivityState {
        const analyzeSession = this.sessionManager.getSession(guildId);
        const articleSession = this.vcArticleManager.getSession(guildId);
        const analyzeActive = analyzeSession.hasActiveConnection()
            && analyzeSession.isRecording
            && analyzeSession.voiceConnection?.joinConfig.channelId === channelId;
        const articleActive = articleSession.hasActiveConnection()
            && articleSession.isRecording
            && articleSession.voiceConnection?.joinConfig.channelId === channelId;

        return {
            analyzeActive,
            articleActive,
            sharedConnection: analyzeActive
                && articleActive
                && analyzeSession.voiceConnection === articleSession.voiceConnection,
        };
    }

    private registerManagedVoiceConnection(guildId: string, connection: VoiceConnection): void {
        if (this.managedVoiceConnections.has(connection)) {
            this.seedVoiceParticipantsForConnection(guildId, connection);
            return;
        }

        this.managedVoiceConnections.add(connection);

        connection.on('stateChange', (oldState, newState) => {
            console.log(`[Shared Voice] ${oldState.status} -> ${newState.status}`);
            if (newState.status === VoiceConnectionStatus.Disconnected) {
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                    .catch(() => connection.destroy());
            }
            if (newState.status === VoiceConnectionStatus.Destroyed) {
                this.sessionManager.cleanupDestroyedConnection(guildId, connection);
                this.vcArticleManager.cleanupDestroyedConnection(guildId, connection);
            }
            if (newState.status === VoiceConnectionStatus.Ready) {
                this.seedVoiceParticipantsForConnection(guildId, connection);
            }
        });
        connection.on('error', (error) => {
            console.error('[Shared Voice] Connection Error:', error);
        });
        connection.on('debug', (message) => {
            console.log(`[Shared Voice Debug] ${message}`);
        });

        this.seedVoiceParticipantsForConnection(guildId, connection);
    }

    private seedVoiceParticipantsForConnection(guildId: string, connection: VoiceConnection): void {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) {
            return;
        }

        const channel = guild.channels.cache.get(connection.joinConfig.channelId);
        if (!channel?.isVoiceBased()) {
            return;
        }

        this.seedVoiceParticipants(connection, channel);
    }

    private seedVoiceParticipants(connection: VoiceConnection, voiceChannel: VoiceBasedChannel): void {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            return;
        }

        const networkingState = connection.state.networking.state as {
            connectionData?: {
                connectedClients?: Set<string>;
            };
        };
        const connectedClients = networkingState.connectionData?.connectedClients;
        if (!connectedClients) {
            return;
        }

        for (const [memberId, member] of voiceChannel.members) {
            if (member.user.bot) {
                continue;
            }
            connectedClients.add(memberId);
        }

        console.log(
            `[Voice Seed] Seeded ${connectedClients.size} connected client(s) for channel ${voiceChannel.id}`
        );
    }
}
