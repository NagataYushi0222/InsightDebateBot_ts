import {
    Client,
    GatewayIntentBits,
    ChatInputCommandInteraction,
    REST,
    Routes,
    Events,
    MessageFlags,
    TextChannel,
    VoiceBasedChannel,
} from 'discord.js';
import {
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
    entersState,
} from '@ovencord/voice';
import { DISCORD_TOKEN } from './config';
import { initDb } from './database';
import { SessionManager } from './sessionManager';
import { LiveVoiceStatusDisplay } from './liveVoiceStatusDisplay';
import { VoiceDisconnectReporter } from './voiceDisconnectReporter';
import { buildBotCommands } from './commands/builders';
import { AnalyzeModeEnvironment } from './commands/analyzeModes';
import {
    handleConfiguredAnalyzeLikeNow,
    handleConfiguredAnalyzeLikeStop,
    handleConfiguredAnalyzeStart,
} from './commands/analyzeModeHandlers';
import { handleModelCommand, handleSettingsCommand } from './commands/settings';
import { buildAnalyzeCheckMessage } from './commands/display';
import { handleImakitaCommand } from './commands/imakita';
import { ImakitaSessionManager } from './imakitaSession';

// データベース初期化
initDb();

// Discordクライアント作成
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const sessionManager = new SessionManager(client);
const imakitaManager = new ImakitaSessionManager();
const liveVoiceStatusDisplay = new LiveVoiceStatusDisplay(client, sessionManager);
const voiceDisconnectReporter = new VoiceDisconnectReporter(client, sessionManager, liveVoiceStatusDisplay);
sessionManager.setStatusAnchorHandler((guildId, message) => liveVoiceStatusDisplay.bindMessage(guildId, message));

const analyzeModeEnvironment: AnalyzeModeEnvironment = {
    sessionManager,
    liveVoiceStatusDisplay,
    ensureVoiceConnection: async ({ guildId, interaction, voiceChannel }) => {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator: interaction.guild!.voiceAdapterCreator,
            selfDeaf: false,
            debug: true,
        });

        connection.on('stateChange', (oldState, newState) => {
            console.log(`[Voice] ${oldState.status} -> ${newState.status}`);

            if (newState.status === VoiceConnectionStatus.Disconnected) {
                try {
                    console.log('[Voice] Disconnected. Attempting to reconnect...');
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                        .catch(async () => {
                            console.log('[Voice] Reconnect failed. Destroying connection.');
                            await voiceDisconnectReporter.reportBeforeDestroy({
                                guildId,
                                connection,
                                reason: 'Discord の音声接続が切断され、5秒以内に再接続できなかったため',
                            });
                        });
                } catch {
                    void voiceDisconnectReporter.reportBeforeDestroy({
                        guildId,
                        connection,
                        reason: 'Discord の音声接続が切断され、再接続処理を開始できなかったため',
                    });
                }
            }

            if (newState.status === VoiceConnectionStatus.Destroyed) {
                console.log('[Voice] Connection destroyed. Cleaning up stale session state.');
                void voiceDisconnectReporter.report({
                    guildId,
                    connection,
                    reason: '音声接続が破棄されたため',
                });
                sessionManager.cleanupDestroyedConnection(guildId, connection);
            }

            if (newState.status === VoiceConnectionStatus.Ready) {
                seedVoiceParticipants(connection, voiceChannel);
            }
        });
        connection.on('error', (error) => {
            console.error('[Voice] Connection Error:', error);
        });
        connection.on('debug', (message) => {
            console.log(`[Voice Debug] ${message}`);
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        } catch (error) {
            await voiceDisconnectReporter.reportBeforeDestroy({
                guildId,
                connection,
                reason: 'VC 接続の開始中に Ready 状態へ到達できなかったため',
                detail: error instanceof Error ? error.message : String(error),
                fallbackTextChannel: interaction.channel as TextChannel | null,
            });
            throw error;
        }
        return { connection, reused: false };
    },
    shouldDestroyConnection: () => true,
    voiceDisconnectReporter,
};

function seedVoiceParticipants(connection: VoiceConnection, voiceChannel: VoiceBasedChannel): void {
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

    console.log(`[Voice Seed] Seeded ${connectedClients.size} connected client(s) for channel ${voiceChannel.id}`);
}

// === コマンド定義 ===
const commands = buildBotCommands();

// === イベントハンドラ ===
client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // スラッシュコマンドを登録
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        await rest.put(Routes.applicationCommands(client.user!.id), {
            body: commands.map((c) => c.toJSON()),
        });
        console.log('Synced global commands');
    } catch (e) {
        console.error('Failed to sync commands:', e);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    const guildId = interaction.guild.id;

    try {
        if (interaction.commandName === 'analyze_start') {
            await handleAnalyzeStart(interaction, guildId);
        } else if (interaction.commandName === 'analyze_stop') {
            await handleAnalyzeStop(interaction, guildId);
        } else if (interaction.commandName === 'analyze_now') {
            await handleAnalyzeNow(interaction, guildId);
        } else if (interaction.commandName === 'analyze_stop_final') {
            await handleAnalyzeStopFinal(interaction, guildId);
        } else if (interaction.commandName === 'settings') {
            await handleSettings(interaction, guildId);
        } else if (interaction.commandName === 'model') {
            await handleModel(interaction, guildId);
        } else if (interaction.commandName === 'check') {
            await handleCheck(interaction, guildId);
        } else if (interaction.commandName === 'imakita') {
            await handleImakitaCommand(interaction, guildId, imakitaManager);
        }
    } catch (e: any) {
        // Unknown interaction (10062) は無視する
        if (e.code === 10062) return;

        console.error('Command error:', e);
        try {
            const reply = interaction.deferred || interaction.replied
                ? interaction.followUp.bind(interaction)
                : interaction.reply.bind(interaction);
            await reply({ content: `エラーが発生しました: ${e}`, flags: MessageFlags.Ephemeral });
        } catch (innerError: any) {
            // エラー応答自体が失敗した場合（10062など）は無視
            if (innerError.code !== 10062) {
                console.error('Failed to send error response:', innerError);
            }
        }
    }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    // 自身のイベントは無視
    if (oldState.member?.id === client.user?.id) {
        if (oldState.channelId && oldState.channelId !== newState.channelId) {
            const guildId = oldState.guild.id;
            const session = sessionManager.getExistingSession(guildId);
            const connection = session?.voiceConnection || null;
            if (connection?.joinConfig.channelId === oldState.channelId) {
                await voiceDisconnectReporter.reportBeforeDestroy({
                    guildId,
                    connection,
                    reason: newState.channelId
                        ? 'Bot が別の VC へ移動したため'
                        : 'Bot が VC から退出したため',
                    detail: 'Discord の VoiceStateUpdate で Bot の在室先変更を検知しました。',
                    fallbackTextChannel: session?.targetTextChannel || null,
                });
            }
        }
        return;
    }

    // ユーザーがチャンネルから退出したか確認
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        const guildId = oldState.guild.id;
        const session = sessionManager.getSession(guildId);

        if (!session.hasActiveConnection() || !session.isRecording) return;

        const botChannelId = session.voiceConnection!.joinConfig.channelId;
        
        // Botがいるチャンネルから退出した場合
        if (oldState.channelId === botChannelId) {
            const channel = oldState.channel;
            if (channel) {
                // Bot以外のメンバーの数をカウント
                const nonBotMembers = channel.members.filter(m => !m.user.bot);
                if (nonBotMembers.size === 0) {
                    // 全員退出したので終了処理
                    const textChannel = session.targetTextChannel;
                    if (textChannel) {
                        await textChannel.send("👋 全員がボイスチャンネルから退出したため、自動的に分析を終了します。");
                    }
                    await voiceDisconnectReporter.report({
                        guildId,
                        connection: session.voiceConnection,
                        reason: '対象VC内の参加者が全員退出したため',
                        fallbackTextChannel: textChannel,
                    });
                    await sessionManager.cleanupSession(guildId, false);
                }
            }
        }
    }
});

// === コマンドハンドラ ===
async function handleAnalyzeStart(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeStart(interaction, guildId, analyzeModeEnvironment);
}

async function handleAnalyzeStop(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeLikeStop(interaction, guildId, analyzeModeEnvironment, 'analyze', true);
}

async function handleAnalyzeStopFinal(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeLikeStop(interaction, guildId, analyzeModeEnvironment, 'analyze', false);
}

async function handleAnalyzeNow(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeLikeNow(interaction, guildId, analyzeModeEnvironment, 'analyze');
}

async function handleSettings(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleSettingsCommand(interaction, guildId, sessionManager);
}

async function handleModel(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleModelCommand(interaction, guildId);
}

async function handleCheck(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await interaction.reply({
        content: buildAnalyzeCheckMessage({
            guildId,
            session: sessionManager.getSession(guildId),
            extraLines: ['🧠 **推論レベル**: 🔥 最高 (high)'],
        }),
        flags: MessageFlags.Ephemeral,
    });
}

// === Bot起動 ===
export function runBot(): void {
    if (!DISCORD_TOKEN) {
        console.error('No DISCORD_TOKEN provided. Exiting.');
        process.exit(1);
    }
    liveVoiceStatusDisplay.start();
    client.login(DISCORD_TOKEN);
}
