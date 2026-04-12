import {
    ChatInputCommandInteraction,
    Client,
    Events,
    GatewayIntentBits,
    Message,
    MessageFlags,
    REST,
    Routes,
    SlashCommandBuilder,
    TextChannel,
} from 'discord.js';
import {
    DEFAULT_MODEL,
    DISCORD_TOKEN,
    GEMINI_MODEL_3_FLASH,
    GEMINI_MODEL_31_FLASH_LITE,
    GEMINI_MODEL_FLASH,
    GUILD_ID,
} from './config';
import {
    getGuildSettings,
    getUserKey,
    initDb,
    updateGuildSetting,
    setUserKey,
} from './database';
import { SessionManager } from './sessionManager';
import { VcArticleSessionManager } from './vcArticle/sessionManager';
import { ArchivedSessionSummary, listArchivedSessions } from './vcArticle/storage';
import { SharedVoiceCoordinator } from './sharedVoiceCoordinator';
import { RuntimeMonitor } from './runtimeMonitor';
import { LiveVoiceStatusDisplay } from './liveVoiceStatusDisplay';

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

const commands = [
    new SlashCommandBuilder()
        .setName('analyze_start')
        .setDescription('ボイスチャットの分析を開始します'),

    new SlashCommandBuilder()
        .setName('analyze_stop')
        .setDescription('分析を終了します（最終レポートなし）'),

    new SlashCommandBuilder()
        .setName('analyze_now')
        .setDescription('すぐにレポートを作成します（分析間隔を待たずに実行）'),

    new SlashCommandBuilder()
        .setName('analyze_stop_final')
        .setDescription('最終レポートを作成してから分析を終了します'),

    new SlashCommandBuilder()
        .setName('article_start')
        .setDescription('VC記事化用の録音を開始します'),

    new SlashCommandBuilder()
        .setName('article_stop')
        .setDescription('録音を停止し、記事候補トピックを抽出します'),

    new SlashCommandBuilder()
        .setName('article_topics')
        .setDescription('直近のVC記事化トピック一覧を再表示します'),

    new SlashCommandBuilder()
        .setName('article_archives')
        .setDescription('保存済みのVC音声セッション一覧を表示します')
        .addIntegerOption((opt) =>
            opt
                .setName('limit')
                .setDescription('表示件数')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30)
        ),

    new SlashCommandBuilder()
        .setName('article_load')
        .setDescription('保存済みのVC音声セッションを選択してトピック抽出します')
        .addStringOption((opt) =>
            opt
                .setName('archive_id')
                .setDescription('読み込みたい保存済みセッションID')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('article_write')
        .setDescription('選んだトピックから記事を生成します')
        .addIntegerOption((opt) =>
            opt
                .setName('topic')
                .setDescription('記事化したいトピック番号')
                .setRequired(true)
                .setMinValue(1)
        ),

    new SlashCommandBuilder()
        .setName('article_discard')
        .setDescription('記事化用の録音・キャッシュを破棄します'),

    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Botの設定を変更します')
        .addSubcommand((sub) =>
            sub
                .setName('set_apikey')
                .setDescription('Gemini APIキーを設定・更新します（あなた専用のキーとして保存されます）')
                .addStringOption((opt) =>
                    opt.setName('key').setDescription('APIキー').setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('set_mode')
                .setDescription('分析モードを変更します (debate / summary)')
                .addStringOption((opt) =>
                    opt
                        .setName('mode')
                        .setDescription('分析モード')
                        .setRequired(true)
                        .addChoices(
                            { name: 'debate', value: 'debate' },
                            { name: 'summary', value: 'summary' }
                        )
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('set_interval')
                .setDescription('分析間隔（秒）を変更します')
                .addIntegerOption((opt) =>
                    opt
                        .setName('seconds')
                        .setDescription('秒数（最低60秒）')
                        .setRequired(true)
                        .setMinValue(60)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('set_model')
                .setDescription('使用するAIモデルを変更します')
                .addStringOption((opt) =>
                    opt
                        .setName('model')
                        .setDescription('モデル')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Gemini 2.5 Flash', value: GEMINI_MODEL_FLASH },
                            { name: 'Gemini 3 Flash (Preview)', value: GEMINI_MODEL_3_FLASH },
                            { name: 'Gemini 3.1 Flash Lite (Preview)', value: GEMINI_MODEL_31_FLASH_LITE }
                        )
                )
        ),

    new SlashCommandBuilder()
        .setName('model')
        .setDescription('使用するAIモデルを変更します')
        .addStringOption((opt) =>
            opt
                .setName('model')
                .setDescription('モデル')
                .setRequired(true)
                .addChoices(
                    { name: 'Gemini 2.5 Flash', value: GEMINI_MODEL_FLASH },
                    { name: 'Gemini 3 Flash (Preview)', value: GEMINI_MODEL_3_FLASH },
                    { name: 'Gemini 3.1 Flash Lite (Preview)', value: GEMINI_MODEL_31_FLASH_LITE }
                )
        ),

    new SlashCommandBuilder()
        .setName('check')
        .setDescription('現在のBot設定を確認します'),
];

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        if (GUILD_ID) {
            await rest.put(
                Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
                { body: commands.map((c) => c.toJSON()) }
            );
            console.log(`Synced commands to guild ${GUILD_ID}`);
        } else {
            await rest.put(Routes.applicationCommands(client.user!.id), {
                body: commands.map((c) => c.toJSON()),
            });
            console.log('Synced global commands');
        }
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
    const userKey = getUserKey(interaction.user.id);
    if (!userKey) {
        await interaction.reply({
            content: '❌ **APIキーが設定されていません**。\n`/settings set_apikey [あなたのキー]` で一度だけ登録してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const member = interaction.guild!.members.cache.get(interaction.user.id);
    const voiceChannel = member?.voice.channel;

    if (!voiceChannel) {
        await interaction.reply({
            content: 'ボイスチャットに参加してからコマンドを実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const session = sessionManager.getSession(guildId);
    if (session.isBusy()) {
        await interaction.followUp(session.isStoppingInProgress()
            ? '要約モードは終了処理中です。完了してからもう一度実行してください。'
            : '既に分析を実行中です。');
        return;
    }

    try {
        const { connection, reused } = await sharedVoiceCoordinator.ensureVoiceConnectionForChannel(
            guildId,
            voiceChannel,
            interaction.guild!.voiceAdapterCreator
        );

        const settings = getGuildSettings(guildId);
        const mode = settings.analysis_mode || 'debate';
        const interval = settings.recording_interval || 300;
        const intervalMins = Math.floor(interval / 60);

        const initialMessage = await interaction.followUp(
            `👥｜**${voiceChannel.name}** の分析を開始しました。\n` +
            'プライバシー保護のため、録音・分析が行われることを参加者に周知してください。\n' +
            `\`[設定] 間隔: ${intervalMins}分 / モード: ${mode}\`\n\n` +
            `${reused ? '🔗 同じVCで動作中の接続を共有して開始しました。\n' : ''}` +
            `⏳ 次のレポート出力まで: 約 ${intervalMins}分`
        );

        await session.startRecording(
            connection,
            interaction.channel as TextChannel,
            userKey,
            voiceChannel.name
        );
        await liveVoiceStatusDisplay.bindMessage(guildId, initialMessage);
    } catch (error) {
        if (session.hasActiveConnection() || session.isBusy()) {
            await session.stopRecording(true, sharedVoiceCoordinator.shouldDestroyAnalyzeConnection(guildId));
        }
        await interaction.followUp(`エラーが発生しました: ${error}`);
    }
}

async function handleAnalyzeStop(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await interaction.deferReply();
    const session = sessionManager.getSession(guildId);

    if (session.isStoppingInProgress()) {
        await interaction.followUp({
            content: '要約モードはすでに終了処理中です。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (session.hasActiveConnection()) {
        runtimeMonitor.logSessionCleanup('manual_analyze_stop', guildId);
        await sessionManager.cleanupSession(
            guildId,
            true,
            sharedVoiceCoordinator.shouldDestroyAnalyzeConnection(guildId)
        );
        const message = await interaction.followUp('✅ 分析を終了しました。お疲れ様でした！');
        await liveVoiceStatusDisplay.bindMessage(guildId, message);
        return;
    }

    await interaction.followUp({
        content: '分析は実行されていません。',
        flags: MessageFlags.Ephemeral,
    });
}

async function handleAnalyzeStopFinal(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    await interaction.deferReply();
    const session = sessionManager.getSession(guildId);

    if (session.isStoppingInProgress()) {
        await interaction.followUp({
            content: '要約モードはすでに終了処理中です。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (session.hasActiveConnection()) {
        const progressMessage = await interaction.followUp('🔄 最終レポートを作成して終了します。しばらくお待ちください...');
        await liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
        runtimeMonitor.logSessionCleanup('manual_analyze_stop_final', guildId);
        await sessionManager.cleanupSession(
            guildId,
            false,
            sharedVoiceCoordinator.shouldDestroyAnalyzeConnection(guildId)
        );
        const doneMessage = await interaction.followUp('✅ 最終レポートを作成し、分析を終了しました。お疲れ様でした！');
        await liveVoiceStatusDisplay.bindMessage(guildId, doneMessage);
        return;
    }

    await interaction.followUp({
        content: '分析は実行されていません。',
        flags: MessageFlags.Ephemeral,
    });
}

async function handleAnalyzeNow(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const session = sessionManager.getSession(guildId);

    if (session.isRecording) {
        await interaction.reply({ content: '🔄 手動分析を開始しました...' });
        await session.processAudio(true, false);
        return;
    }

    await interaction.reply({
        content: '分析は実行されていません。先に /analyze_start を実行してください。',
        flags: MessageFlags.Ephemeral,
    });
}

async function handleArticleStart(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const userKey = getUserKey(interaction.user.id);
    if (!userKey) {
        await interaction.reply({
            content: '❌ APIキーが設定されていません。\n`/settings set_apikey [あなたのキー]` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const articleSession = vcArticleManager.getSession(guildId);
    if (articleSession.isBusy()) {
        await interaction.reply({
            content: articleSession.isStoppingInProgress()
                ? '記事化用の録音は停止処理中です。完了してからもう一度実行してください。'
                : '記事化用の録音はすでに実行中です。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const member = interaction.guild!.members.cache.get(interaction.user.id);
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel) {
        await interaction.reply({
            content: 'ボイスチャットに参加してからコマンドを実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const { connection, reused } = await sharedVoiceCoordinator.ensureVoiceConnectionForChannel(
        guildId,
        voiceChannel,
        interaction.guild!.voiceAdapterCreator
    );
    await articleSession.startRecording(
        connection,
        interaction.channel as TextChannel,
        interaction.guild!,
        userKey,
        voiceChannel.name
    );

    const initialMessage = await interaction.followUp(
        `📰 **VC記事化モードを開始しました**\n` +
        `対象VC: **${voiceChannel.name}**\n` +
        `${reused ? '🔗 同じVCで動作中の接続を共有して開始しました。\n' : ''}` +
        '録音終了後に `/article_stop` を実行すると、記事候補トピックを抽出します。\n' +
        '同じテキストチャンネルの投稿は、記事化の参考ログとして取り込みます。'
    );
    await liveVoiceStatusDisplay.bindMessage(guildId, initialMessage);
}

async function handleArticleStop(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const articleSession = vcArticleManager.getSession(guildId);
    if (articleSession.isStoppingInProgress()) {
        await interaction.reply({
            content: '記事化用の録音はすでに停止処理中です。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!articleSession.hasActiveConnection() || !articleSession.isRecording) {
        await interaction.reply({
            content: '記事化用の録音は実行されていません。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();
    const progressMessage = await interaction.followUp('🔄 録音を停止しました。VC から退出し、記事候補トピックを抽出しています...');
    await liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    runtimeMonitor.logSessionCleanup('manual_article_stop', guildId);
    const topicResult = await articleSession.stopAndExtractTopics(
        sharedVoiceCoordinator.shouldDestroyArticleConnection(guildId)
    );
    const lastMessage = await followUpInChunks(
        interaction,
        formatTopicsMessage(topicResult, articleSession.getActiveArchiveId()),
    );
    if (lastMessage) {
        await liveVoiceStatusDisplay.bindMessage(guildId, lastMessage);
    } else {
        liveVoiceStatusDisplay.refreshNow(guildId);
    }
}

async function handleArticleTopics(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const topicResult = vcArticleManager.getSession(guildId).getTopicResult();
    if (!topicResult) {
        await interaction.reply({
            content: 'まだ記事候補はありません。先に `/article_stop` または `/article_load` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await replyInChunks(interaction, formatTopicsMessage(topicResult, vcArticleManager.getSession(guildId).getActiveArchiveId()));
}

async function handleArticleArchives(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const limit = interaction.options.getInteger('limit') ?? 10;
    const archives = listArchivedSessions(limit, guildId);

    await replyInChunks(interaction, formatArchiveListMessage(archives));
}

async function handleArticleLoad(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const archiveId = interaction.options.getString('archive_id', true).trim();
    const userKey = getUserKey(interaction.user.id);
    if (!userKey) {
        await interaction.reply({
            content: '❌ APIキーが設定されていません。\n`/settings set_apikey [あなたのキー]` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const articleSession = vcArticleManager.getSession(guildId);
    if (articleSession.isBusy()) {
        await interaction.reply({
            content: '記事化用の録音が実行中です。先に `/article_stop` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();
    const progressMessage = await interaction.followUp(`📂 保存済み音声 ${archiveId} を読み込み、保存済み記事候補を確認しています...`);
    await liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    const topicResult = await articleSession.loadArchiveAndExtractTopics(archiveId, userKey);
    const lastMessage = await followUpInChunks(
        interaction,
        formatTopicsMessage(topicResult, articleSession.getActiveArchiveId()),
    );
    if (lastMessage) {
        await liveVoiceStatusDisplay.bindMessage(guildId, lastMessage);
    }
}

async function handleArticleWrite(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const topicId = interaction.options.getInteger('topic', true);
    const articleSession = vcArticleManager.getSession(guildId);

    if (!articleSession.hasTopicCache()) {
        await interaction.reply({
            content: '記事化対象のトピックがありません。先に `/article_stop` または `/article_load` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();
    const progressMessage = await interaction.followUp(`📝 トピック ${topicId} から記事を生成しています...`);
    await liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    const article = await articleSession.generateArticle(topicId);
    const lastMessage = await followUpInChunks(interaction, article);
    if (lastMessage) {
        await liveVoiceStatusDisplay.bindMessage(guildId, lastMessage);
    }
}

async function handleArticleDiscard(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    runtimeMonitor.logSessionCleanup('manual_article_discard', guildId);
    await vcArticleManager.cleanupSession(
        guildId,
        sharedVoiceCoordinator.shouldDestroyArticleConnection(guildId)
    );
    await interaction.reply({
        content: '🧹 現在の録音・選択中キャッシュを破棄しました。保存済み音声ファイル自体は残ります。',
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSettings(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'set_apikey': {
            let key = interaction.options.getString('key') ?? interaction.options.getString('apikey');

            if (!key) {
                const subCmd = interaction.options.data.find((opt) => opt.name === 'set_apikey');
                if (subCmd?.options && subCmd.options.length > 0) {
                    const firstOpt = subCmd.options[0];
                    if (typeof firstOpt.value === 'string') {
                        key = firstOpt.value;
                    }
                }
            }

            if (!key) {
                await interaction.reply({
                    content: '❌ APIキーが正しく認識されませんでした。入力欄の `key` を選択してから入力してください。',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            if (!key.startsWith('AIza')) {
                await interaction.reply({
                    content: '❌ 無効なAPIキーの形式です。正しいキーを入力してください。',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            setUserKey(interaction.user.id, key);
            await interaction.reply({
                content: '✅ APIキーを保存しました！以後、あなたのキーが自動で使用されます。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        case 'set_mode': {
            const mode = interaction.options.getString('mode');
            if (!mode) {
                await interaction.reply({ content: '❌ モードが指定されていません。', flags: MessageFlags.Ephemeral });
                return;
            }
            updateGuildSetting(guildId, 'analysis_mode', mode);
            await interaction.reply(`✅ 分析モードを '${mode}' に変更しました。`);
            return;
        }

        case 'set_interval': {
            const seconds = interaction.options.getInteger('seconds');
            if (seconds === null) {
                await interaction.reply({ content: '❌ 秒数が指定されていません。', flags: MessageFlags.Ephemeral });
                return;
            }
            updateGuildSetting(guildId, 'recording_interval', seconds);
            await sessionManager.getSession(guildId).syncSettingsAndStatus();
            await interaction.reply(`✅ 分析間隔を ${seconds}秒 (${(seconds / 60).toFixed(1)}分) に変更しました。`);
            return;
        }

        case 'set_model': {
            const model = interaction.options.getString('model');
            if (!model) {
                await interaction.reply({ content: '❌ モデルが指定されていません。', flags: MessageFlags.Ephemeral });
                return;
            }
            updateGuildSetting(guildId, 'model_name', model);
            await interaction.reply(`✅ 使用モデルを '${model}' に変更しました。`);
            return;
        }
    }
}

async function handleModel(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const model = interaction.options.getString('model');
    if (!model) {
        await interaction.reply({ content: '❌ モデルが指定されていません。', flags: MessageFlags.Ephemeral });
        return;
    }
    updateGuildSetting(guildId, 'model_name', model);
    await interaction.reply(`✅ 使用モデルを '${model}' に変更しました。`);
}

function getModelDisplayName(modelId: string): string {
    switch (modelId) {
        case GEMINI_MODEL_FLASH:
            return 'Gemini 2.5 Flash';
        case GEMINI_MODEL_3_FLASH:
            return 'Gemini 3 Flash (Preview)';
        case GEMINI_MODEL_31_FLASH_LITE:
            return 'Gemini 3.1 Flash Lite (Preview)';
        default:
            return modelId;
    }
}

function getModeDisplayName(mode: string): string {
    switch (mode) {
        case 'debate':
            return '🗣️ ディベート (debate)';
        case 'summary':
            return '📝 要約 (summary)';
        default:
            return mode;
    }
}

async function handleCheck(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const settings = getGuildSettings(guildId);
    const session = sessionManager.getSession(guildId);
    const articleSession = vcArticleManager.getSession(guildId);
    const isRecording = session.isRecording;
    const liveStatus = session.getStatusSummary();

    const modelName = settings.model_name || DEFAULT_MODEL;
    const modelDisplay = getModelDisplayName(modelName);
    const modeDisplay = getModeDisplayName(settings.analysis_mode || 'debate');
    const interval = settings.recording_interval || 300;
    const remainingLabel = liveStatus.remainingSeconds === null
        ? '停止中'
        : `${Math.floor(liveStatus.remainingSeconds / 60)}分${liveStatus.remainingSeconds % 60}秒`;
    const statusEmoji = isRecording ? '🔴' : session.isStoppingInProgress() ? '🟡' : '⏹️';
    const articleStatus = articleSession.isRecording
        ? '📰 VC記事化録音中'
        : articleSession.isStoppingInProgress()
            ? '🟡 記事候補を生成中'
        : articleSession.hasTopicCache()
            ? '🗂️ 記事トピック保持中'
            : '⏹️ 記事化停止中';
    const activeArchiveId = articleSession.getActiveArchiveId() || 'なし';
    const activeArchiveLabel = articleSession.getActiveArchiveLabel() || 'なし';

    const embed = [
        '━━━━━━━━━━━━━━━━━━━━━━',
        '⚙️ **現在のBot設定**',
        '━━━━━━━━━━━━━━━━━━━━━━',
        '',
        `🤖 **使用モデル**: ${modelDisplay}`,
        `   \`${modelName}\``,
        '',
        `📋 **分析モード**: ${modeDisplay}`,
        '',
        `⏱️ **分析間隔**: ${interval}秒 (${(interval / 60).toFixed(1)}分)`,
        '',
        `📡 **要約Bot状態**: ${statusEmoji} ${liveStatus.status}`,
        `🛠️ **要約Bot処理**: ${liveStatus.task}`,
        `⏳ **次回レポートまで**: ${remainingLabel}`,
        `📰 **記事化機能状態**: ${articleStatus}`,
        `🗂️ **選択中アーカイブ**: ${activeArchiveId}`,
        `📝 **選択中タイトル**: ${activeArchiveLabel}`,
        '━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');

    await interaction.reply({
        content: embed,
        flags: MessageFlags.Ephemeral,
    });
}

function formatTopicsMessage(
    topicResult: { sessionSummary: string; topics: Array<{ id: number; title: string; summary: string; reason: string; speakers: string[]; includesTextChat: boolean; }> },
    archiveId: string | null = null
): string {
    if (topicResult.topics.length === 0) {
        return [
            '📰 **記事候補トピックを抽出しました**',
            '',
            archiveId ? `保存ID: ${archiveId}` : '',
            archiveId ? '' : '',
            `概要: ${topicResult.sessionSummary || '有効な会話を十分に抽出できませんでした。'}`,
            '',
            '記事化に向いたトピックは見つかりませんでした。',
        ].filter(Boolean).join('\n');
    }

    const lines = [
        '📰 **記事候補トピックを抽出しました**',
        '',
        ...(archiveId ? [`保存ID: ${archiveId}`, ''] : []),
        `概要: ${topicResult.sessionSummary || '会話全体の概要なし'}`,
        '',
    ];

    for (const topic of topicResult.topics) {
        const speakers = topic.speakers.length > 0 ? topic.speakers.join(', ') : '不明';
        lines.push(`${topic.id}. **${topic.title}**`);
        lines.push(`   - 要約: ${topic.summary}`);
        lines.push(`   - 記事向きな理由: ${topic.reason}`);
        lines.push(`   - 主な話者: ${speakers}`);
        lines.push(`   - テキスト反映: ${topic.includesTextChat ? 'あり' : 'なし'}`);
        lines.push('');
    }

    lines.push('記事化するには `/article_write topic:<番号>` を実行してください。');
    return lines.join('\n');
}

function formatArchiveListMessage(archives: ArchivedSessionSummary[]): string {
    if (archives.length === 0) {
        return [
            '📂 **保存済みVC音声一覧**',
            '',
            '保存済みの音声セッションはありません。',
        ].join('\n');
    }

    const lines = [
        '📂 **保存済みVC音声一覧**',
        '',
        '読み込みには `/article_load archive_id:<ID>` を使ってください。',
        '',
    ];

    for (const archive of archives) {
        lines.push(`- タイトル: ${archive.summaryLabel || '(未解析)'}`);
        lines.push(`- ID: \`${archive.archiveId}\``);
        lines.push(`  日時: ${formatArchiveDate(archive.createdAt)} / VC: ${archive.voiceChannelName}`);
        lines.push(`  音声: ${archive.fileCount}ファイル / 話者: ${archive.speakerCount}人 / チャット: ${archive.textEntryCount}件 / 容量: ${formatBytes(archive.totalBytes)}`);
    }

    return lines.join('\n');
}

function formatArchiveDate(isoString: string): string {
    const date = new Date(isoString);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function splitForDiscord(content: string, maxLength: number = 1900): string[] {
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > maxLength) {
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex < Math.floor(maxLength * 0.6)) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.slice(0, splitIndex).trim());
        remaining = remaining.slice(splitIndex).trim();
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}

async function followUpInChunks(
    interaction: ChatInputCommandInteraction,
    content: string
): Promise<Message | null> {
    let lastMessage: Message | null = null;
    for (const chunk of splitForDiscord(content)) {
        lastMessage = await interaction.followUp(chunk);
    }
    return lastMessage;
}

async function replyInChunks(
    interaction: ChatInputCommandInteraction,
    content: string
): Promise<void> {
    const chunks = splitForDiscord(content);
    await interaction.reply(chunks[0]);

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
    }
}

async function sendChannelMessageInChunks(channel: TextChannel, content: string): Promise<void> {
    for (const chunk of splitForDiscord(content)) {
        await channel.send(chunk);
    }
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
