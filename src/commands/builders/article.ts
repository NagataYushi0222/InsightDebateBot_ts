import {
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

type ArticleCommandBuilder = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;

export function buildArticleCommands(): ArticleCommandBuilder[] {
    return [
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
    ];
}
