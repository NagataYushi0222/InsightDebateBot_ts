import {
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

type AnalyzeCommandBuilder = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;

export function buildAnalyzeCommands(): AnalyzeCommandBuilder[] {
    return [
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
    ];
}

export function buildDialogueCommands(): AnalyzeCommandBuilder[] {
    return [
        new SlashCommandBuilder()
            .setName('dialogue_start')
            .setDescription('テーマを指定して対話モードを開始します')
            .addStringOption((opt) =>
                opt
                    .setName('theme')
                    .setDescription('今回の対話テーマ')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('dialogue_stop')
            .setDescription('対話モードを終了します（最終レポートなし）'),
        new SlashCommandBuilder()
            .setName('dialogue_now')
            .setDescription('対話モードのレポートを今すぐ作成します'),
        new SlashCommandBuilder()
            .setName('dialogue_stop_final')
            .setDescription('最終レポートを作成してから対話モードを終了します'),
    ];
}
