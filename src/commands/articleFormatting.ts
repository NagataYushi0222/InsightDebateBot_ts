import { ArchivedSessionSummary } from '../vcArticle/storage';
import { TopicExtractionResult } from '../vcArticle/types';
import { formatArchiveDate, formatBytes } from './display';

export function formatTopicsMessage(
    topicResult: TopicExtractionResult,
    archiveId: string | null = null,
): string {
    if (topicResult.topics.length === 0) {
        return [
            '📰 **記事候補トピックを抽出しました**',
            '',
            ...(archiveId ? [`保存ID: ${archiveId}`, ''] : []),
            `概要: ${topicResult.sessionSummary || '有効な会話を十分に抽出できませんでした。'}`,
            '',
            '記事化に向いたトピックは見つかりませんでした。',
        ].join('\n');
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

export function formatArchiveListMessage(archives: ArchivedSessionSummary[]): string {
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
