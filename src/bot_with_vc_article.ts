import {
    ChatInputCommandInteraction,
    Client,
    Events,
    GatewayIntentBits,
    MessageFlags,
    REST,
    Routes,
} from 'discord.js';
import {
    DISCORD_TOKEN,
} from './config';
import {
    getGuildSettings,
    initDb,
} from './database';
import { SessionManager } from './sessionManager';
import { VcArticleSessionManager } from './vcArticle/sessionManager';
import { SharedVoiceCoordinator } from './sharedVoiceCoordinator';
import { RuntimeMonitor } from './runtimeMonitor';
import { LiveVoiceStatusDisplay } from './liveVoiceStatusDisplay';
import { buildBotCommands } from './commands/builders';
import { AnalyzeModeEnvironment } from './commands/analyzeModes';
import {
    handleConfiguredAnalyzeLikeNow,
    handleConfiguredAnalyzeLikeStop,
    handleConfiguredAnalyzeStart,
    handleConfiguredDialogueStart,
} from './commands/analyzeModeHandlers';
import {
    handleArticleArchivesCommand,
    handleArticleDiscardCommand,
    handleArticleLoadCommand,
    handleArticleStartCommand,
    handleArticleStopCommand,
    handleArticleTopicsCommand,
    handleArticleWriteCommand,
} from './commands/article';
import { formatTopicsMessage } from './commands/articleFormatting';
import { buildAnalyzeCheckMessage, getModeDisplayName } from './commands/display';
import { sendChannelMessageInChunks } from './commands/replies';
import { handleModelCommand, handleSettingsCommand } from './commands/settings';

initDb();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const sessionManager = new SessionManager(client);
const vcArticleManager = new VcArticleSessionManager(client);
const sharedVoiceCoordinator = new SharedVoiceCoordinator(client, sessionManager, vcArticleManager);
const runtimeMonitor = new RuntimeMonitor(client, sessionManager, vcArticleManager, sharedVoiceCoordinator);
const liveVoiceStatusDisplay = new LiveVoiceStatusDisplay(client, sessionManager, vcArticleManager);
sessionManager.setStatusAnchorHandler((guildId, message) => liveVoiceStatusDisplay.bindMessage(guildId, message));

const analyzeModeEnvironment: AnalyzeModeEnvironment = {
    sessionManager,
    liveVoiceStatusDisplay,
    ensureVoiceConnection: async ({ guildId, interaction, voiceChannel }) => (
        sharedVoiceCoordinator.ensureVoiceConnectionForChannel(
            guildId,
            voiceChannel,
            interaction.guild!.voiceAdapterCreator
        )
    ),
    shouldDestroyConnection: (guildId) => sharedVoiceCoordinator.shouldDestroyAnalyzeConnection(guildId),
    logCleanup: (reason, guildId) => runtimeMonitor.logSessionCleanup(reason, guildId),
};
const articleEnvironment = {
    vcArticleManager,
    sharedVoiceCoordinator,
    runtimeMonitor,
    liveVoiceStatusDisplay,
};
const commands = buildBotCommands({
    includeDialogue: true,
    includeArticle: true,
});

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        await rest.put(Routes.applicationCommands(client.user!.id), {
            body: commands.map((c) => c.toJSON()),
        });
        console.log('Synced global commands');
    } catch (error) {
        console.error('Failed to sync commands:', error);
    }
});

client.on(Events.MessageCreate, (message) => {
    if (!message.guild) return;
    vcArticleManager.getSession(message.guild.id).recordTextMessage(message);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guild) return;

    const guildId = interaction.guild.id;

    try {
        switch (interaction.commandName) {
            case 'analyze_start':
                await handleAnalyzeStart(interaction, guildId);
                break;
            case 'analyze_stop':
                await handleAnalyzeStop(interaction, guildId);
                break;
            case 'analyze_now':
                await handleAnalyzeNow(interaction, guildId);
                break;
            case 'analyze_stop_final':
                await handleAnalyzeStopFinal(interaction, guildId);
                break;
            case 'dialogue_start':
                await handleDialogueStart(interaction, guildId);
                break;
            case 'dialogue_stop':
                await handleDialogueStop(interaction, guildId);
                break;
            case 'dialogue_now':
                await handleDialogueNow(interaction, guildId);
                break;
            case 'dialogue_stop_final':
                await handleDialogueStopFinal(interaction, guildId);
                break;
            case 'article_start':
                await handleArticleStart(interaction, guildId);
                break;
            case 'article_stop':
                await handleArticleStop(interaction, guildId);
                break;
            case 'article_topics':
                await handleArticleTopics(interaction, guildId);
                break;
            case 'article_archives':
                await handleArticleArchives(interaction, guildId);
                break;
            case 'article_load':
                await handleArticleLoad(interaction, guildId);
                break;
            case 'article_write':
                await handleArticleWrite(interaction, guildId);
                break;
            case 'article_discard':
                await handleArticleDiscard(interaction, guildId);
                break;
            case 'settings':
                await handleSettings(interaction, guildId);
                break;
            case 'model':
                await handleModel(interaction, guildId);
                break;
            case 'check':
                await handleCheck(interaction, guildId);
                break;
        }
    } catch (error: any) {
        if (error.code === 10062) return;

        console.error('Command error:', error);
        try {
            const reply = interaction.deferred || interaction.replied
                ? interaction.followUp.bind(interaction)
                : interaction.reply.bind(interaction);
            await reply({
                content: `エラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (innerError: any) {
            if (innerError.code !== 10062) {
                console.error('Failed to send error response:', innerError);
            }
        }
    }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (oldState.member?.id === client.user?.id) {
        runtimeMonitor.logBotVoiceStateChange(
            oldState.guild.id,
            oldState.channelId,
            newState.channelId,
        );
        return;
    }

    const guildId = oldState.guild.id;
    sharedVoiceCoordinator.syncActiveConnectionParticipants(guildId);

    if (!oldState.channelId || oldState.channelId === newState.channelId) return;

    const analyzeSession = sessionManager.getSession(guildId);
    const articleSession = vcArticleManager.getSession(guildId);
    const { analyzeActive, articleActive, sharedConnection } =
        sharedVoiceCoordinator.getChannelActivityState(guildId, oldState.channelId);

    if (!analyzeActive && !articleActive) {
        return;
    }

    const channel = oldState.channel;
    if (!channel) {
        return;
    }

    const nonBotMembers = channel.members.filter((member) => !member.user.bot);
    if (nonBotMembers.size > 0) {
        return;
    }

    if (analyzeActive && analyzeSession.targetTextChannel) {
        await analyzeSession.targetTextChannel.send('👋 全員がボイスチャンネルから退出したため、自動的に分析を終了します。');
    }

    if (articleActive && articleSession.targetTextChannel) {
        await articleSession.targetTextChannel.send('👋 全員が退出したため、録音を停止して記事候補を抽出します。');
    }

    if (analyzeActive) {
        runtimeMonitor.logSessionCleanup('all_members_left_analyze', guildId);
        await sessionManager.cleanupSession(guildId, false, !sharedConnection);
    }

    if (!articleActive) {
        return;
    }

    const articleTextChannel = articleSession.targetTextChannel;
    if (articleTextChannel) {
        runtimeMonitor.logSessionCleanup('all_members_left_article', guildId);
        const topicResult = await articleSession.stopAndExtractTopics(true);
        await sendChannelMessageInChunks(
            articleTextChannel,
            formatTopicsMessage(topicResult, articleSession.getActiveArchiveId())
        );
    } else {
        runtimeMonitor.logSessionCleanup('all_members_left_article_without_text_channel', guildId);
        await vcArticleManager.cleanupSession(guildId, true);
    }
});

async function handleAnalyzeStart(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const settings = getGuildSettings(guildId);
    const mode = settings.analysis_mode || 'debate';
    if (mode === 'dialogue') {
        await interaction.reply({
            content: '対話モードは `/dialogue_start theme:...` で開始してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await handleConfiguredAnalyzeStart(interaction, guildId, analyzeModeEnvironment);
}

async function handleAnalyzeStop(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleConfiguredAnalyzeLikeStop(interaction, guildId, analyzeModeEnvironment, 'analyze', true);
}

async function handleAnalyzeStopFinal(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleConfiguredAnalyzeLikeStop(interaction, guildId, analyzeModeEnvironment, 'analyze', false);
}

async function handleAnalyzeNow(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleConfiguredAnalyzeLikeNow(interaction, guildId, analyzeModeEnvironment, 'analyze');
}

async function handleDialogueStart(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredDialogueStart(interaction, guildId, analyzeModeEnvironment);
}

async function handleDialogueStop(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeLikeStop(interaction, guildId, analyzeModeEnvironment, 'dialogue', true);
}

async function handleDialogueStopFinal(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeLikeStop(interaction, guildId, analyzeModeEnvironment, 'dialogue', false);
}

async function handleDialogueNow(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    await handleConfiguredAnalyzeLikeNow(interaction, guildId, analyzeModeEnvironment, 'dialogue');
}

async function handleArticleStart(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleStartCommand(interaction, guildId, articleEnvironment);
}

async function handleArticleStop(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleStopCommand(interaction, guildId, articleEnvironment);
}

async function handleArticleTopics(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleTopicsCommand(interaction, guildId, articleEnvironment);
}

async function handleArticleArchives(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleArchivesCommand(interaction, guildId);
}

async function handleArticleLoad(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleLoadCommand(interaction, guildId, articleEnvironment);
}

async function handleArticleWrite(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleWriteCommand(interaction, guildId, articleEnvironment);
}

async function handleArticleDiscard(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleArticleDiscardCommand(interaction, guildId, articleEnvironment);
}

async function handleSettings(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleSettingsCommand(interaction, guildId, sessionManager);
}

async function handleModel(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await handleModelCommand(interaction, guildId);
}

async function handleCheck(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const session = sessionManager.getSession(guildId);
    const articleSession = vcArticleManager.getSession(guildId);
    const articleStatus = articleSession.isRecording
        ? '📰 VC記事化録音中'
        : articleSession.isStoppingInProgress()
            ? '🟡 記事候補を生成中'
            : articleSession.hasTopicCache()
            ? '🗂️ 記事トピック保持中'
            : '⏹️ 記事化停止中';
    const activeArchiveId = articleSession.getActiveArchiveId() || 'なし';
    const activeArchiveLabel = articleSession.getActiveArchiveLabel() || 'なし';

    await interaction.reply({
        content: buildAnalyzeCheckMessage({
            guildId,
            session,
            extraLines: [
                `📰 **記事化機能状態**: ${articleStatus}`,
                `🗂️ **選択中アーカイブ**: ${activeArchiveId}`,
                `📝 **選択中タイトル**: ${activeArchiveLabel}`,
            ],
        }),
        flags: MessageFlags.Ephemeral,
    });
}

export function runBotWithVcArticle(): void {
    if (!DISCORD_TOKEN) {
        console.error('No DISCORD_TOKEN provided. Exiting.');
        process.exit(1);
    }
    runtimeMonitor.start();
    liveVoiceStatusDisplay.start();
    client.login(DISCORD_TOKEN);
}
