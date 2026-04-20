import {
    ChatInputCommandInteraction,
    MessageFlags,
} from 'discord.js';
import {
    getUserKey,
    setUserKey,
    updateGuildSetting,
} from '../database';
import { SessionManager } from '../sessionManager';

export async function handleSettingsCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    sessionManager: SessionManager,
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
                await interaction.reply({
                    content: '❌ モードが指定されていません。',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            updateGuildSetting(guildId, 'analysis_mode', mode);
            await interaction.reply(`✅ 分析モードを '${mode}' に変更しました。`);
            return;
        }

        case 'set_interval': {
            const seconds = interaction.options.getInteger('seconds');
            if (seconds === null) {
                await interaction.reply({
                    content: '❌ 秒数が指定されていません。',
                    flags: MessageFlags.Ephemeral,
                });
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
                await interaction.reply({
                    content: '❌ モデルが指定されていません。',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            updateGuildSetting(guildId, 'model_name', model);
            await interaction.reply(`✅ 使用モデルを '${model}' に変更しました。`);
        }
    }
}

export async function handleModelCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    const model = interaction.options.getString('model');
    if (!model) {
        await interaction.reply({
            content: '❌ モデルが指定されていません。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    updateGuildSetting(guildId, 'model_name', model);
    await interaction.reply(`✅ 使用モデルを '${model}' に変更しました。`);
}

export function getRequiredUserApiKey(interaction: ChatInputCommandInteraction): string | null {
    return getUserKey(interaction.user.id);
}
