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
} from 'discord.js';
import {
    joinVoiceChannel,
    VoiceConnectionStatus,
    entersState,
} from '@ovencord/voice';
import { DISCORD_TOKEN, GUILD_ID, GEMINI_MODEL_FLASH, GEMINI_MODEL_3_FLASH, GEMINI_MODEL_31_FLASH_LITE, DEFAULT_MODEL } from './config';
import { initDb, updateGuildSetting, getGuildSettings } from './database';
import { SessionManager } from './sessionManager';

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

// === コマンド定義 ===
const commands = [
    new SlashCommandBuilder()
        .setName('rec')
        .setDescription('録音・分析を制御します')
        .addSubcommand((sub) =>
            sub.setName('start').setDescription('録音と分析を開始します')
        )
        .addSubcommand((sub) =>
            sub.setName('stop').setDescription('録音を停止し、分析して終了します')
        )
        .addSubcommand((sub) =>
            sub.setName('now').setDescription('現在までの会話を強制的に分析します')
        ),

    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Botの設定を変更します')
        .addSubcommand((sub) =>
            sub
                .setName('set_key')
                .setDescription('Gemini APIキーを設定します（BYOK）')
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
        if (interaction.commandName === 'rec') {
            const subcommand = interaction.options.getSubcommand();
            switch (subcommand) {
                case 'start':
                    await handleAnalyzeStart(interaction, guildId);
                    break;
                case 'stop':
                    await handleAnalyzeStop(interaction, guildId);
                    break;
                case 'now':
                    await handleAnalyzeNow(interaction, guildId);
                    break;
            }
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

// === コマンドハンドラ ===

async function handleAnalyzeStart(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
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
    if (session.voiceConnection) {
        await interaction.followUp('既に分析を実行中です。');
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
        });
        connection.on('error', error => {
            console.error('[Voice] Connection Error:', error);
        });
        connection.on('debug', (message) => {
            console.log(`[Voice Debug] ${message}`);
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

        await interaction.followUp(
            `${voiceChannel.name} の分析を開始しました。プライバシー保護のため、録音・分析が行われることを参加者に周知してください。`
        );

        // セッションで録音開始
        await session.startRecording(
            connection,
            interaction.channel as TextChannel
        );
    } catch (e) {
        if (session.voiceConnection) {
            await session.stopRecording();
        }
        await interaction.followUp(`エラーが発生しました: ${e}`);
    }
}

async function handleAnalyzeStop(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const session = sessionManager.getSession(guildId);

    if (session.voiceConnection) {
        await sessionManager.cleanupSession(guildId);
        await interaction.reply('分析を終了しました。');
    } else {
        await interaction.reply({
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

    if (session.voiceConnection) {
        await interaction.reply({
            content: '分析リクエストを受け付けました。しばらくお待ちください...',
            flags: MessageFlags.Ephemeral
        });
        await session.processAudio(true);
    } else {
        await interaction.reply({
            content: '分析は実行されていません。先に /rec start を実行してください。',
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
        case 'set_key': {
            const key = interaction.options.getString('key', true);
            updateGuildSetting(guildId, 'api_key', key);
            await interaction.reply({
                content:
                    '✅ APIキーを更新しました。次回分析からこのキーが使用されます。',
                flags: MessageFlags.Ephemeral,
            });
            break;
        }

        case 'set_mode': {
            const mode = interaction.options.getString('mode', true);
            updateGuildSetting(guildId, 'analysis_mode', mode);
            await interaction.reply(
                `✅ 分析モードを '${mode}' に変更しました。`
            );
            break;
        }

        case 'set_interval': {
            const seconds = interaction.options.getInteger('seconds', true);
            updateGuildSetting(guildId, 'recording_interval', seconds);
            await interaction.reply(
                `✅ 分析間隔を ${seconds}秒 (${(seconds / 60).toFixed(1)}分) に変更しました。`
            );
            break;
        }

        case 'set_model': {
            const model = interaction.options.getString('model', true);
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
    const model = interaction.options.getString('model', true);
    updateGuildSetting(guildId, 'model_name', model);
    await interaction.reply(
        `✅ 使用モデルを **${model}** に変更しました。`
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
        default: return mode;
    }
}

async function handleCheck(
    interaction: ChatInputCommandInteraction,
    guildId: string
): Promise<void> {
    const settings = getGuildSettings(guildId);
    const session = sessionManager.getSession(guildId);
    const isRecording = !!session.voiceConnection;

    const modelName = settings.model_name || DEFAULT_MODEL;
    const modelDisplay = getModelDisplayName(modelName);
    const modeDisplay = getModeDisplayName(settings.analysis_mode || 'debate');
    const interval = settings.recording_interval || 300;
    const hasApiKey = !!settings.api_key;

    const statusEmoji = isRecording ? '🔴 録音中' : '⏹️ 停止中';

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
        `🧠 **推論レベル**: 🔥 最高 (high)`,
        '',
        `🔑 **APIキー**: ${hasApiKey ? '✅ 設定済み (BYOK)' : '🌐 環境変数を使用'}`,
        '',
        `📡 **ステータス**: ${statusEmoji}`,
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
    client.login(DISCORD_TOKEN);
}
