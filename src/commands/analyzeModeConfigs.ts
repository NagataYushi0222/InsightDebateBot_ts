export interface AnalyzeInitialMessageParams {
    voiceChannelName: string;
    intervalMins: number;
    reused: boolean;
    mode: string;
    dialogueTheme: string | null;
}

export interface AnalyzeLikeModeConfig {
    expectedMode?: string;
    buildInitialMessage: (params: AnalyzeInitialMessageParams) => string;
    stop: {
        doneLabel: string;
        notRunningLabel: string;
        cleanupReason: string;
    };
    stopFinal: {
        stoppingLabel: string;
        doneLabel: string;
        notRunningLabel: string;
        cleanupReason: string;
    };
    now: {
        startLabel: string;
        notRunningLabel: string;
    };
}

export const analyzeLikeModeConfigs: Record<'analyze' | 'dialogue', AnalyzeLikeModeConfig> = {
    analyze: {
        buildInitialMessage: ({ voiceChannelName, intervalMins, reused, mode }) =>
            `👥｜**${voiceChannelName}** の分析を開始しました。\n` +
            'プライバシー保護のため、録音・分析が行われることを参加者に周知してください。\n' +
            `\`[設定] 間隔: ${intervalMins}分 / モード: ${mode}\`\n\n` +
            `${reused ? '🔗 同じVCで動作中の接続を共有して開始しました。\n' : ''}` +
            `⏳ 次のレポート出力まで: 約 ${intervalMins}分`,
        stop: {
            doneLabel: '✅ 分析を終了しました。お疲れ様でした！',
            notRunningLabel: '分析は実行されていません。',
            cleanupReason: 'manual_analyze_stop',
        },
        stopFinal: {
            stoppingLabel: '🔄 最終レポートを作成して終了します。しばらくお待ちください...',
            doneLabel: '✅ 最終レポートを作成し、分析を終了しました。お疲れ様でした！',
            notRunningLabel: '分析は実行されていません。',
            cleanupReason: 'manual_analyze_stop_final',
        },
        now: {
            startLabel: '🔄 手動分析を開始しました...',
            notRunningLabel: '分析は実行されていません。先に /analyze_start を実行してください。',
        },
    },
    dialogue: {
        expectedMode: 'dialogue',
        buildInitialMessage: ({ voiceChannelName, intervalMins, reused, dialogueTheme }) =>
            `💬 **対話モードを開始しました**\n` +
            `対象VC: **${voiceChannelName}**\n` +
            `テーマ: **${dialogueTheme || '未指定'}**\n` +
            'プライバシー保護のため、録音・分析が行われることを参加者に周知してください。\n' +
            `\`[設定] 間隔: ${intervalMins}分 / モード: dialogue\`\n` +
            `${reused ? '🔗 同じVCで動作中の接続を共有して開始しました。\n' : ''}` +
            `⏳ 次のテーマレポート出力まで: 約 ${intervalMins}分`,
        stop: {
            doneLabel: '✅ 対話モードを終了しました。お疲れ様でした！',
            notRunningLabel: '対話モードは実行されていません。',
            cleanupReason: 'manual_dialogue_stop',
        },
        stopFinal: {
            stoppingLabel: '🔄 最終の対話レポートを作成して終了します。しばらくお待ちください...',
            doneLabel: '✅ 最終の対話レポートを作成し、対話モードを終了しました。お疲れ様でした！',
            notRunningLabel: '対話モードは実行されていません。',
            cleanupReason: 'manual_dialogue_stop_final',
        },
        now: {
            startLabel: '🔄 手動で対話レポートを作成しています...',
            notRunningLabel: '対話モードは実行されていません。先に /dialogue_start を実行してください。',
        },
    },
};
