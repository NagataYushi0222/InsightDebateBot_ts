import {
    Client,
    GatewayIntentBits,
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    REST,
    Routes,
    TextChannel,
    Events,
    MessageFlags,
    VoiceBasedChannel,
} from 'discord.js';
import {
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
    entersState,
} from '@ovencord/voice';
import { DISCORD_TOKEN, GUILD_ID, GEMINI_MODEL_FLASH, GEMINI_MODEL_3_FLASH, GEMINI_MODEL_31_FLASH_LITE, DEFAULT_MODEL } from './config';
import { initDb, updateGuildSetting, getGuildSettings, getUserKey, setUserKey } from './database';
import { SessionManager } from './sessionManager';
import { LiveVoiceStatusDisplay } from './liveVoiceStatusDisplay';

// データベース初期化
initDb();

// Discordクライアント作成
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
    ],
});

const sessionManager = new SessionManager(client);
const liveVoiceStatusDisplay = new LiveVoiceStatusDisplay(client, sessionManager);
sessionManager.setStatusAnchorHandler((guildId, message) => liveVoiceStatusDisplay.bindMessage(guildId, message));

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

// === イベントハンドラ ===
client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // スラッシュコマンドを登録
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        if (GUILD_ID) {
            // テスト用：特定ギルドに登録（即時反映）
            await rest.put(
                Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
                { body: commands.map((c) => c.toJSON()) }
            );
            console.log(`Synced commands to guild ${GUILD_ID}`);
        } else {
            // グローバル登録
            await rest.put(Routes.applicationCommands(client.user!.id), {
                body: commands.map((c) => c.toJSON()),
            });
            console.log('Synced global commands');
        }
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
    if (oldState.member?.id === client.user?.id) return;

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
                    await sessionManager.cleanupSession(guildId, false);
                }
            }
        }
    }
});

// === コマンドハンドラ ===

async function handleAnalyzeStart(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const userKey = getUserKey(interaction.user.id);
    if (!userKey) {
        await interaction.reply({
            content: '❌ **APIキーが設定されていません**。\\n`/settings set_apikey [あなたのキー]` で一度だけ登録してください。',
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

    // 既に録音中か確認
    if (session.isBusy()) {
        await interaction.followUp(session.isStoppingInProgress()
            ? '要約モードは終了処理中です。完了してからもう一度実行してください。'
            : '既に分析を実行中です。');
        return;
    }

    try {
        // ボイスチャンネルに接続
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guildId,
            adapterCreator: interaction.guild!.voiceAdapterCreator,
            selfDeaf: false,
            debug: true,
        });

        // デバッグログを追加（接続失敗の原因特定用）
        connection.on('stateChange', (oldState, newState) => {
            console.log(`[Voice] ${oldState.status} -> ${newState.status}`);

            // Disconnected 状態になった場合、再接続を試みる
            if (newState.status === VoiceConnectionStatus.Disconnected) {
                try {
                    console.log('[Voice] Disconnected. Attempting to reconnect...');
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                        .catch(() => {
                            console.log('[Voice] Reconnect failed. Destroying connection.');
                            connection.destroy();
                        });
                } catch {
                    connection.destroy();
                }
            }

            if (newState.status === VoiceConnectionStatus.Destroyed) {
                console.log('[Voice] Connection destroyed. Cleaning up stale session state.');
                sessionManager.cleanupDestroyedConnection(guildId, connection);
            }

            if (newState.status === VoiceConnectionStatus.Ready) {
                seedVoiceParticipants(connection, voiceChannel);
            }
        });
        connection.on('error', error => {
            console.error('[Voice] Connection Error:', error);
        });
        connection.on('debug', (message) => {
            console.log(`[Voice Debug] ${message}`);
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

        const settings = getGuildSettings(guildId);
        const mode = settings.analysis_mode || 'debate';
        const interval = settings.recording_interval || 300;
        const intervalMins = Math.floor(interval / 60);

        const initialMsgContent = `👥｜**${voiceChannel.name}** の分析を開始しました。
プライバシー保護のため、録音・分析が行われることを参加者に周知してください。
\`[設定] 間隔: ${intervalMins}分 / モード: ${mode}\`

⏳ 次のレポート出力まで: 約 ${intervalMins}分`;

        const initialMessage = await interaction.followUp(initialMsgContent);

        // セッションで録音開始
        await session.startRecording(
            connection,
            interaction.channel as TextChannel,
            {
                apiKey: userKey,
                voiceChannelName: voiceChannel.name,
                analysisMode: mode,
            }
        );
        await liveVoiceStatusDisplay.bindMessage(guildId, initialMessage);
    } catch (e) {
        if (session.hasActiveConnection() || session.isBusy()) {
            await session.stopRecording(true);
        }
        await interaction.followUp(`エラーが発生しました: ${e}`);
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
        await sessionManager.cleanupSession(guildId, true);
        const message = await interaction.followUp('✅ 分析を終了しました。お疲れ様でした！');
        await liveVoiceStatusDisplay.bindMessage(guildId, message);
    } else {
        await interaction.followUp({
            content: '分析は実行されていません。',
            flags: MessageFlags.Ephemeral,
        });
    }
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
        await sessionManager.cleanupSession(guildId, false);
        const doneMessage = await interaction.followUp('✅ 最終レポートを作成し、分析を終了しました。お疲れ様でした！');
        await liveVoiceStatusDisplay.bindMessage(guildId, doneMessage);
    } else {
        await interaction.followUp({
            content: '分析は実行されていません。',
            flags: MessageFlags.Ephemeral,
        });
    }
}


async function handleAnalyzeNow(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const session = sessionManager.getSession(guildId);

    if (session.isRecording) {
        await interaction.reply({
            content: '🔄 手動分析を開始しました...'
        });
        await session.processAudio(true, false);
    } else {
        await interaction.reply({
            content: '分析は実行されていません。先に /analyze_start を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
    }
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
                // 自動補完やキャッシュの問題で名前がずれている場合のフォールバック
                const subCmd = interaction.options.data.find(opt => opt.name === 'set_apikey');
                if (subCmd && subCmd.options && subCmd.options.length > 0) {
                    const firstOpt = subCmd.options[0];
                    if (typeof firstOpt.value === 'string') {
                        key = firstOpt.value;
                    }
                }
            }

            if (!key) {
                console.log("Failed to parse key from options:", JSON.stringify(interaction.options.data));
                await interaction.reply({
                    content: "❌ APIキーが正しく認識されませんでした。\\nDiscordの仕様により、入力欄(オプション枠)を選択してから文字を入力する必要があります。入力バーの上に出てくる `key` という枠を選択してから入力してください。",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            if (!key.startsWith("AIza")) {
                await interaction.reply({
                    content: "❌ 無効なAPIキーの形式です。正しいキーを入力してください。",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            setUserKey(interaction.user.id, key);
            await interaction.reply({
                content: '✅ APIキーを保存しました！\n以後、あなたがコマンドを実行するとこのキーが自動で使用されます。',
                flags: MessageFlags.Ephemeral,
            });
            break;
        }

        case 'set_mode': {
            const mode = interaction.options.getString('mode');
            if (!mode) {
                await interaction.reply({ content: "❌ モードが指定されていません。", flags: MessageFlags.Ephemeral });
                return;
            }
            updateGuildSetting(guildId, 'analysis_mode', mode);
            await interaction.reply(
                `✅ 分析モードを '${mode}' に変更しました。`
            );
            break;
        }

        case 'set_interval': {
            const seconds = interaction.options.getInteger('seconds');
            if (seconds === null) {
                await interaction.reply({ content: "❌ 秒数が指定されていません。", flags: MessageFlags.Ephemeral });
                return;
            }
            updateGuildSetting(guildId, 'recording_interval', seconds);
            await sessionManager.getSession(guildId).syncSettingsAndStatus();
            await interaction.reply(
                `✅ 分析間隔を ${seconds}秒 (${(seconds / 60).toFixed(1)}分) に変更しました。`
            );
            break;
        }

        case 'set_model': {
            const model = interaction.options.getString('model');
            if (!model) {
                await interaction.reply({ content: "❌ モデルが指定されていません。", flags: MessageFlags.Ephemeral });
                return;
            }
            updateGuildSetting(guildId, 'model_name', model);
            await interaction.reply(
                `✅ 使用モデルを '${model}' に変更しました。`
            );
            break;
        }
    }
}

async function handleModel(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const model = interaction.options.getString('model');
    if (!model) {
        await interaction.reply({ content: "❌ モデルが指定されていません。", flags: MessageFlags.Ephemeral });
        return;
    }
    updateGuildSetting(guildId, 'model_name', model);
    await interaction.reply(
        `✅ 使用モデルを '${model}' に変更しました。`
    );
}

function getModelDisplayName(modelId: string): string {
    switch (modelId) {
        case GEMINI_MODEL_FLASH: return 'Gemini 2.5 Flash';
        case GEMINI_MODEL_3_FLASH: return 'Gemini 3 Flash (Preview)';
        case GEMINI_MODEL_31_FLASH_LITE: return 'Gemini 3.1 Flash Lite (Preview)';
        default: return modelId;
    }
}

function getModeDisplayName(mode: string): string {
    switch (mode) {
        case 'debate': return '🗣️ ディベート (debate)';
        case 'summary': return '📝 要約 (summary)';
        case 'dialogue': return '💬 対話 (dialogue)';
        default: return mode;
    }
}

async function handleCheck(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const settings = getGuildSettings(guildId);
    const session = sessionManager.getSession(guildId);
    const isRecording = session.isRecording;
    const liveStatus = session.getStatusSummary();

    const modelName = settings.model_name || DEFAULT_MODEL;
    const modelDisplay = getModelDisplayName(modelName);
    const modeDisplay = getModeDisplayName(settings.analysis_mode || 'debate');
    const activeModeDisplay = getModeDisplayName(liveStatus.mode || settings.analysis_mode || 'debate');
    const interval = settings.recording_interval || 300;
    const remainingLabel = liveStatus.remainingSeconds === null
        ? '停止中'
        : `${Math.floor(liveStatus.remainingSeconds / 60)}分${liveStatus.remainingSeconds % 60}秒`;
    const statusEmoji = isRecording ? '🔴' : session.isStoppingInProgress() ? '🟡' : '⏹️';

    const embed = [
        '━━━━━━━━━━━━━━━━━━━━━━',
        '⚙️ **現在のBot設定**',
        '━━━━━━━━━━━━━━━━━━━━━━',
        '',
        `🤖 **使用モデル**: ${modelDisplay}`,
        `   \`${modelName}\``,
        '',
        `📋 **分析モード**: ${modeDisplay}`,
        `🎯 **現在の実行モード**: ${activeModeDisplay}`,
        ...(liveStatus.dialogueTheme ? [`🧵 **対話テーマ**: ${liveStatus.dialogueTheme}`] : []),
        '',
        `⏱️ **分析間隔**: ${interval}秒 (${(interval / 60).toFixed(1)}分)`,
        '',
        `🧠 **推論レベル**: 🔥 最高 (high)`,
        '',
        `📡 **分析Bot状態**: ${statusEmoji} ${liveStatus.status}`,
        `🛠️ **分析Bot処理**: ${liveStatus.task}`,
        `⏳ **次回レポートまで**: ${remainingLabel}`,
        '━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');

    await interaction.reply({
        content: embed,
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
