import {
    DEFAULT_MODEL,
    GEMINI_MODEL_3_FLASH,
    GEMINI_MODEL_31_FLASH_LITE,
    GEMINI_MODEL_FLASH,
} from '../config';
import { getGuildSettings } from '../database';
import { AnalyzeStatusSummary, GuildSession } from '../sessionManager';

export function getModelDisplayName(modelId: string): string {
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

export function getModeDisplayName(mode: string): string {
    switch (mode) {
        case 'debate':
            return '🗣️ ディベート (debate)';
        case 'summary':
            return '📝 要約 (summary)';
        case 'dialogue':
            return '💬 対話 (dialogue)';
        default:
            return mode;
    }
}

export function buildAnalyzeCheckMessage(params: {
    guildId: string;
    session: GuildSession;
    extraLines?: string[];
}): string {
    const {
        guildId,
        session,
        extraLines = [],
    } = params;
    const settings = getGuildSettings(guildId);
    const liveStatus: AnalyzeStatusSummary = session.getStatusSummary();
    const modelName = settings.model_name || DEFAULT_MODEL;
    const modelDisplay = getModelDisplayName(modelName);
    const modeDisplay = getModeDisplayName(settings.analysis_mode || 'debate');
    const activeModeDisplay = getModeDisplayName(liveStatus.mode || settings.analysis_mode || 'debate');
    const interval = settings.recording_interval || 300;
    const remainingLabel = liveStatus.remainingSeconds === null
        ? '停止中'
        : `${Math.floor(liveStatus.remainingSeconds / 60)}分${liveStatus.remainingSeconds % 60}秒`;
    const statusEmoji = session.isRecording ? '🔴' : session.isStoppingInProgress() ? '🟡' : '⏹️';

    return [
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
        `📡 **分析Bot状態**: ${statusEmoji} ${liveStatus.status}`,
        `🛠️ **分析Bot処理**: ${liveStatus.task}`,
        `⏳ **次回レポートまで**: ${remainingLabel}`,
        ...extraLines,
        '━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
}

export function formatArchiveDate(isoString: string): string {
    const date = new Date(isoString);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
