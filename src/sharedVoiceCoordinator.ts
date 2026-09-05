import {
    entersState,
    joinVoiceChannel,
    VoiceConnectionDisconnectReason,
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import { Client, VoiceBasedChannel } from 'discord.js';
import { SessionManager } from './sessionManager';
import { VcArticleSessionManager } from './vcArticle/sessionManager';
import { ImakitaSessionManager } from './imakitaSession';

interface ChannelActivityState {
    analyzeActive: boolean;
    articleActive: boolean;
    sharedConnection: boolean;
}

interface MutableNetworkingState {
    code?: number;
    connectionData?: {
        connectedClients?: Set<string>;
    };
    dave?: {
        reinit?: () => void;
        reinitializing?: boolean;
    };
}

interface VoiceStateWithDisconnectDetails {
    status: VoiceConnectionStatus;
    reason?: VoiceConnectionDisconnectReason;
    closeCode?: number;
}

export interface SharedVoiceDisconnectEvent {
    guildId: string;
    connection: VoiceConnection;
    reason: string;
    detail?: string;
}

const SENSITIVE_KEY_PATTERN = /("(?:secretKey|token|sessionId|session_id|secret_key|authorization)")\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^\s,}\]]+)/gi;

function redactVoiceDebugMessage(message: string): string {
    return message.replace(SENSITIVE_KEY_PATTERN, '$1: "[REDACTED]"');
}

export class SharedVoiceCoordinator {
    private readonly managedVoiceConnections = new WeakSet<VoiceConnection>();
    private readonly lastDaveReinitAt = new WeakMap<VoiceConnection, number>();

    constructor(
        private readonly client: Client,
        private readonly sessionManager: SessionManager,
        private readonly vcArticleManager: VcArticleSessionManager,
        private readonly imakitaManager: ImakitaSessionManager,
        private readonly onVoiceDisconnect?: (event: SharedVoiceDisconnectEvent) => Promise<void> | void,
    ) {}

    getActiveGuildVoiceConnection(guildId: string): VoiceConnection | null {
        const analyzeSession = this.sessionManager.getExistingSession(guildId);
        // 「接続オブジェクトが残っている」ではなく、「実際に録音中」を active とみなす。
        if (analyzeSession?.isRecording && analyzeSession.hasActiveConnection()) {
            return analyzeSession.voiceConnection;
        }

        const articleSession = this.vcArticleManager.getExistingSession(guildId);
        if (articleSession?.isRecording && articleSession.hasActiveConnection()) {
            return articleSession.voiceConnection;
        }
        const imakitaSession = this.imakitaManager.getExistingSession(guildId);
        if (imakitaSession?.isRecording && imakitaSession.hasActiveConnection()) return imakitaSession.voiceConnection;

        return null;
    }

    shouldDestroyAnalyzeConnection(guildId: string): boolean {
        const { sharedConnection, articleActive } = this.getGuildActivityState(guildId);
        return !(articleActive || !!this.imakitaManager.getExistingSession(guildId)?.isRecording);
    }

    shouldDestroyArticleConnection(guildId: string): boolean {
        const { sharedConnection, analyzeActive } = this.getGuildActivityState(guildId);
        return !(analyzeActive || !!this.imakitaManager.getExistingSession(guildId)?.isRecording);
    }

    getChannelActivityState(guildId: string, channelId: string): ChannelActivityState {
        return this.buildActivityState(guildId, channelId);
    }

    syncActiveConnectionParticipants(guildId: string): void {
        const connection = this.getActiveGuildVoiceConnection(guildId);
        if (!connection) {
            return;
        }

        this.syncParticipantsForConnection(guildId, connection);
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
            this.syncParticipantsForConnection(guildId, existingConnection);
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
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        } catch (error) {
            await this.notifyBeforeDestroy({
                guildId,
                connection,
                reason: 'VC 接続の開始中に Ready 状態へ到達できなかったため',
                detail: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
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
        const analyzeSession = this.sessionManager.getExistingSession(guildId);
        const articleSession = this.vcArticleManager.getExistingSession(guildId);
        const analyzeActive = !!analyzeSession?.hasActiveConnection()
            && analyzeSession.isRecording
            && analyzeSession.voiceConnection?.joinConfig.channelId === channelId;
        const articleActive = !!articleSession?.hasActiveConnection()
            && articleSession.isRecording
            && articleSession.voiceConnection?.joinConfig.channelId === channelId;

        return {
            analyzeActive,
            articleActive,
            // 同じ VoiceConnection を両モードが本当に共有している場合だけ shared 扱いにする。
            sharedConnection: analyzeActive
                && articleActive
                && analyzeSession?.voiceConnection === articleSession?.voiceConnection,
        };
    }

    private registerManagedVoiceConnection(guildId: string, connection: VoiceConnection): void {
        if (this.managedVoiceConnections.has(connection)) {
            this.syncParticipantsForConnection(guildId, connection);
            return;
        }

        this.managedVoiceConnections.add(connection);

        connection.on('stateChange', (oldState, newState) => {
            console.log(
                [
                    '[Shared Voice]',
                    `guild=${guildId}`,
                    `channel=${connection.joinConfig.channelId}`,
                    `${oldState.status} -> ${newState.status}`,
                    this.describeVoiceState(newState as VoiceStateWithDisconnectDetails),
                    `rejoin_attempts=${connection.rejoinAttempts}`,
                ].join(' '),
            );
            if (newState.status === VoiceConnectionStatus.Disconnected) {
                const detail = this.describeVoiceState(newState as VoiceStateWithDisconnectDetails);
                console.warn(
                    `[Shared Voice] guild=${guildId} disconnected; waiting up to 5s for reconnect`,
                );
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                    .then(() => {
                        console.log(`[Shared Voice] guild=${guildId} reconnect attempt reached connecting`);
                    })
                    .catch(async (error) => {
                        console.error(`[Shared Voice] guild=${guildId} reconnect failed, destroying connection:`, error);
                        await this.notifyBeforeDestroy({
                            guildId,
                            connection,
                            reason: 'Discord の音声接続が切断され、5秒以内に再接続できなかったため',
                            detail,
                        });
                    });
            }
            if (newState.status === VoiceConnectionStatus.Destroyed) {
                void this.notifyVoiceDisconnect({
                    guildId,
                    connection,
                    reason: '音声接続が破棄されたため',
                });
                this.sessionManager.cleanupDestroyedConnection(guildId, connection);
                this.vcArticleManager.cleanupDestroyedConnection(guildId, connection);
                this.imakitaManager.cleanupDestroyedConnection(guildId, connection);
            }
            if (newState.status === VoiceConnectionStatus.Ready) {
                this.syncParticipantsForConnection(guildId, connection);
            }
        });
        connection.on('error', (error) => {
            console.error('[Shared Voice] Connection Error:', error);
        });
        connection.on('debug', (message) => {
            console.log(`[Shared Voice Debug] ${redactVoiceDebugMessage(message)}`);
        });

        this.syncParticipantsForConnection(guildId, connection);
    }

    private syncParticipantsForConnection(guildId: string, connection: VoiceConnection): void {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) {
            return;
        }

        const channelId = connection.joinConfig.channelId;
        if (!channelId) {
            return;
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isVoiceBased()) {
            return;
        }

        const changed = this.seedVoiceParticipants(connection, channel);
        if (changed) {
            this.reinitializeDaveSession(connection, channel.id);
        }
    }

    private seedVoiceParticipants(connection: VoiceConnection, voiceChannel: VoiceBasedChannel): boolean {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            return false;
        }

        const networkingState = connection.state.networking.state as MutableNetworkingState;
        const connectedClients = networkingState.connectionData?.connectedClients;
        if (!connectedClients) {
            return false;
        }

        const nextMembers = new Set<string>();
        for (const [memberId, member] of voiceChannel.members) {
            if (member.user.bot) {
                continue;
            }
            nextMembers.add(memberId);
        }

        const previousSignature = Array.from(connectedClients).sort().join(',');
        const nextSignature = Array.from(nextMembers).sort().join(',');

        connectedClients.clear();
        for (const memberId of nextMembers) {
            connectedClients.add(memberId);
        }

        console.log(
            `[Voice Seed] Seeded ${connectedClients.size} connected client(s) for channel ${voiceChannel.id}`
        );

        return previousSignature !== nextSignature;
    }

    private reinitializeDaveSession(connection: VoiceConnection, channelId: string): void {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            return;
        }

        const networkingState = connection.state.networking.state as MutableNetworkingState;
        const daveSession = networkingState.dave;
        if (!daveSession?.reinit || daveSession.reinitializing) {
            return;
        }

        const lastReinitAt = this.lastDaveReinitAt.get(connection) ?? 0;
        const now = Date.now();
        if (now - lastReinitAt < 3_000) {
            return;
        }

        this.lastDaveReinitAt.set(connection, now);
        console.log(`[Voice Seed] Reinitializing DAVE session after participant sync for channel ${channelId}`);
        daveSession.reinit();
    }

    private describeVoiceState(state: VoiceStateWithDisconnectDetails): string {
        if (state.status !== VoiceConnectionStatus.Disconnected) {
            return '';
        }

        const reasonLabel = state.reason !== undefined
            ? VoiceConnectionDisconnectReason[state.reason]
            : 'unknown';
        const closeCode = state.closeCode !== undefined ? ` close_code=${state.closeCode}` : '';
        return `reason=${reasonLabel}${closeCode}`;
    }

    private async notifyVoiceDisconnect(event: SharedVoiceDisconnectEvent): Promise<void> {
        try {
            await this.onVoiceDisconnect?.(event);
        } catch (error) {
            console.error(`[Shared Voice] Failed to notify disconnect for guild ${event.guildId}:`, error);
        }
    }

    private async notifyBeforeDestroy(event: SharedVoiceDisconnectEvent): Promise<void> {
        await this.notifyVoiceDisconnect(event);
        if (event.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            event.connection.destroy();
        }
    }
}
