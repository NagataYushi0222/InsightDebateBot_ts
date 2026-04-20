import {
    ChatInputCommandInteraction,
    Guild,
    MessageFlags,
    TextChannel,
} from 'discord.js';
import { LiveVoiceStatusDisplay } from '../liveVoiceStatusDisplay';
import { RuntimeMonitor } from '../runtimeMonitor';
import { SharedVoiceCoordinator } from '../sharedVoiceCoordinator';
import { VcArticleSessionManager } from '../vcArticle/sessionManager';
import { listArchivedSessions } from '../vcArticle/storage';
import { formatArchiveListMessage, formatTopicsMessage } from './articleFormatting';
import { followUpInChunks, replyInChunks } from './replies';
import { getRequiredUserApiKey } from './settings';

interface ArticleEnvironment {
    vcArticleManager: VcArticleSessionManager;
    sharedVoiceCoordinator: SharedVoiceCoordinator;
    runtimeMonitor: RuntimeMonitor;
    liveVoiceStatusDisplay: LiveVoiceStatusDisplay;
}

export async function handleArticleStartCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: ArticleEnvironment,
): Promise<void> {
    const userKey = getRequiredUserApiKey(interaction);
    if (!userKey) {
        await interaction.reply({
            content: '❌ APIキーが設定されていません。\n`/settings set_apikey [あなたのキー]` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const articleSession = environment.vcArticleManager.getSession(guildId);
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

    const { connection, reused } = await environment.sharedVoiceCoordinator.ensureVoiceConnectionForChannel(
        guildId,
        voiceChannel,
        interaction.guild!.voiceAdapterCreator,
    );
    await articleSession.startRecording(
        connection,
        interaction.channel as TextChannel,
        interaction.guild as Guild,
        userKey,
        voiceChannel.name,
    );

    const initialMessage = await interaction.followUp(
        `📰 **VC記事化モードを開始しました**\n` +
        `対象VC: **${voiceChannel.name}**\n` +
        `${reused ? '🔗 同じVCで動作中の接続を共有して開始しました。\n' : ''}` +
        '録音終了後に `/article_stop` を実行すると、記事候補トピックを抽出します。\n' +
        '同じテキストチャンネルの投稿は、記事化の参考ログとして取り込みます。',
    );
    await environment.liveVoiceStatusDisplay.bindMessage(guildId, initialMessage);
}

export async function handleArticleStopCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: ArticleEnvironment,
): Promise<void> {
    const articleSession = environment.vcArticleManager.getSession(guildId);
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
    await environment.liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    environment.runtimeMonitor.logSessionCleanup('manual_article_stop', guildId);
    const topicResult = await articleSession.stopAndExtractTopics(
        environment.sharedVoiceCoordinator.shouldDestroyArticleConnection(guildId),
    );
    const lastMessage = await followUpInChunks(
        interaction,
        formatTopicsMessage(topicResult, articleSession.getActiveArchiveId()),
    );
    if (lastMessage) {
        await environment.liveVoiceStatusDisplay.bindMessage(guildId, lastMessage);
    } else {
        environment.liveVoiceStatusDisplay.refreshNow(guildId);
    }
}

export async function handleArticleTopicsCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: ArticleEnvironment,
): Promise<void> {
    const topicResult = environment.vcArticleManager.getSession(guildId).getTopicResult();
    if (!topicResult) {
        await interaction.reply({
            content: 'まだ記事候補はありません。先に `/article_stop` または `/article_load` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await replyInChunks(
        interaction,
        formatTopicsMessage(topicResult, environment.vcArticleManager.getSession(guildId).getActiveArchiveId()),
    );
}

export async function handleArticleArchivesCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
): Promise<void> {
    const limit = interaction.options.getInteger('limit') ?? 10;
    const archives = listArchivedSessions(limit, guildId);
    await replyInChunks(interaction, formatArchiveListMessage(archives));
}

export async function handleArticleLoadCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: ArticleEnvironment,
): Promise<void> {
    const archiveId = interaction.options.getString('archive_id', true).trim();
    const userKey = getRequiredUserApiKey(interaction);
    if (!userKey) {
        await interaction.reply({
            content: '❌ APIキーが設定されていません。\n`/settings set_apikey [あなたのキー]` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const articleSession = environment.vcArticleManager.getSession(guildId);
    if (articleSession.isBusy()) {
        await interaction.reply({
            content: articleSession.isStoppingInProgress()
                ? '記事化セッションは停止処理中です。保存済み音声の整理とトピック抽出が終わるまで少し待ってから、`/article_topics` または `/article_load` を実行してください。'
                : '記事化用の録音が実行中です。先に `/article_stop` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();
    const progressMessage = await interaction.followUp(`📂 保存済み音声 ${archiveId} を読み込み、保存済み記事候補を確認しています...`);
    await environment.liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    const topicResult = await articleSession.loadArchiveAndExtractTopics(archiveId, userKey);
    const lastMessage = await followUpInChunks(
        interaction,
        formatTopicsMessage(topicResult, articleSession.getActiveArchiveId()),
    );
    if (lastMessage) {
        await environment.liveVoiceStatusDisplay.bindMessage(guildId, lastMessage);
    }
}

export async function handleArticleWriteCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: ArticleEnvironment,
): Promise<void> {
    const topicId = interaction.options.getInteger('topic', true);
    const articleSession = environment.vcArticleManager.getSession(guildId);

    if (!articleSession.hasTopicCache()) {
        await interaction.reply({
            content: '記事化対象のトピックがありません。先に `/article_stop` または `/article_load` を実行してください。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();
    const progressMessage = await interaction.followUp(`📝 トピック ${topicId} から記事を生成しています...`);
    await environment.liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    const article = await articleSession.generateArticle(topicId);
    const lastMessage = await followUpInChunks(interaction, article);
    if (lastMessage) {
        await environment.liveVoiceStatusDisplay.bindMessage(guildId, lastMessage);
    }
}

export async function handleArticleDiscardCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: ArticleEnvironment,
): Promise<void> {
    environment.runtimeMonitor.logSessionCleanup('manual_article_discard', guildId);
    await environment.vcArticleManager.cleanupSession(
        guildId,
        environment.sharedVoiceCoordinator.shouldDestroyArticleConnection(guildId),
    );
    await interaction.reply({
        content: '🧹 現在の録音・選択中キャッシュを破棄しました。保存済み音声ファイル自体は残ります。',
        flags: MessageFlags.Ephemeral,
    });
}
