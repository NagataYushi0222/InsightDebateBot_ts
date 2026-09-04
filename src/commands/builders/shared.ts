import {
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandStringOption,
    SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import {
    GEMINI_MODEL_38_FLASH,
    GEMINI_MODEL_37_FLASH,
    GEMINI_MODEL_35_FLASH_LITE,
} from '../../config';

export type SharedCommandBuilder =
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;

function addModelChoices(option: SlashCommandStringOption): SlashCommandStringOption {
    return option
        .setName('model')
        .setDescription('モデル')
        .setRequired(true)
        .addChoices(
            { name: 'Gemini 3.8 Flash', value: GEMINI_MODEL_38_FLASH },
            { name: 'Gemini 3.7 Flash', value: GEMINI_MODEL_37_FLASH },
            { name: 'Gemini 3.5 Flash Lite', value: GEMINI_MODEL_35_FLASH_LITE }
        );
}

export function buildSharedUtilityCommands(): SharedCommandBuilder[] {
    return [
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
                    .addStringOption((opt) => addModelChoices(opt))
            ),
        new SlashCommandBuilder()
            .setName('model')
            .setDescription('使用するAIモデルを変更します')
            .addStringOption((opt) => addModelChoices(opt)),
        new SlashCommandBuilder()
            .setName('check')
            .setDescription('現在のBot設定を確認します'),
        new SlashCommandBuilder()
            .setName('imakita')
            .setDescription('今北産業：このチャンネルの直近の会話を3行で要約します'),
    ];
}
