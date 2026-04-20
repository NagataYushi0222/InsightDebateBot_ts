import {
    ChatInputCommandInteraction,
    MessageFlags,
    TextChannel,
    VoiceBasedChannel,
} from 'discord.js';
import { VoiceConnection } from '@ovencord/voice';
import { getGuildSettings } from '../database';
import { LiveVoiceStatusDisplay } from '../liveVoiceStatusDisplay';
import { SessionManager } from '../sessionManager';
import { getModeDisplayName } from './display';
import { getRequiredUserApiKey } from './settings';

export interface AnalyzeModeEnvironment {
    sessionManager: SessionManager;
    liveVoiceStatusDisplay: LiveVoiceStatusDisplay;
    ensureVoiceConnection: (params: {
        guildId: string;
        interaction: ChatInputCommandInteraction;
        voiceChannel: VoiceBasedChannel;
    }) => Promise<{ connection: VoiceConnection; reused: boolean }>;
    shouldDestroyConnection: (guildId: string) => boolean;
    logCleanup?: (reason: string, guildId: string) => void;
}

interface AnalyzeStartHandlerOptions {
    mode: string;
    dialogueTheme?: string | null;
    initialMessageBuilder: (params: {
        voiceChannelName: string;
        intervalMins: number;
        reused: boolean;
        mode: string;
        dialogueTheme: string | null;
    }) => string;
}

export async function startAnalyzeLikeSession(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
    options: AnalyzeStartHandlerOptions,
): Promise<void> {
    const userKey = getRequiredUserApiKey(interaction);
    if (!userKey) {
        await interaction.reply({
            content: '❌ **APIキーが設定されていません**。\n`/settings set_apikey [あなたのキー]` で一度だけ登録してください。',
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

    const session = environment.sessionManager.getSession(guildId);
    if (session.isBusy()) {
        await interaction.followUp(session.isStoppingInProgress()
            ? '要約系セッションは終了処理中です。完了してからもう一度実行してください。'
            : '既に要約系セッションを実行中です。');
        return;
    }

    try {
        const { connection, reused } = await environment.ensureVoiceConnection({
            guildId,
            interaction,
            voiceChannel,
        });

        const settings = getGuildSettings(guildId);
        const interval = settings.recording_interval || 300;
        const intervalMins = Math.floor(interval / 60);
        const initialMessage = await interaction.followUp(
            options.initialMessageBuilder({
                voiceChannelName: voiceChannel.name,
                intervalMins,
                reused,
                mode: options.mode,
                dialogueTheme: options.dialogueTheme?.trim() || null,
            }),
        );

        await session.startRecording(
            connection,
            interaction.channel as TextChannel,
            {
                apiKey: userKey,
                voiceChannelName: voiceChannel.name,
                analysisMode: options.mode,
                dialogueTheme: options.dialogueTheme?.trim() || null,
            },
        );
        await environment.liveVoiceStatusDisplay.bindMessage(guildId, initialMessage);
    } catch (error) {
        if (session.hasActiveConnection() || session.isBusy()) {
            await session.stopRecording(true, environment.shouldDestroyConnection(guildId));
        }
        await interaction.followUp(`エラーが発生しました: ${error}`);
    }
}

export async function stopAnalyzeLikeSession(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
    options: {
        expectedMode?: string;
        skipFinal: boolean;
        stoppingLabel: string;
        doneLabel: string;
        notRunningLabel: string;
        cleanupReason: string;
    },
): Promise<void> {
    await interaction.deferReply();
    const session = environment.sessionManager.getSession(guildId);

    if (session.isStoppingInProgress()) {
        await interaction.followUp({
            content: '要約系セッションはすでに終了処理中です。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!session.hasActiveConnection()) {
        await interaction.followUp({
            content: options.notRunningLabel,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (options.expectedMode && session.getActiveAnalysisMode() !== options.expectedMode) {
        await interaction.followUp({
            content: `現在起動中なのは ${getModeDisplayName(session.getActiveAnalysisMode())} です。`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!options.skipFinal) {
        const progressMessage = await interaction.followUp(options.stoppingLabel);
        await environment.liveVoiceStatusDisplay.bindMessage(guildId, progressMessage);
    }

    environment.logCleanup?.(options.cleanupReason, guildId);
    await environment.sessionManager.cleanupSession(
        guildId,
        options.skipFinal,
        environment.shouldDestroyConnection(guildId),
    );
    const doneMessage = await interaction.followUp(options.doneLabel);
    await environment.liveVoiceStatusDisplay.bindMessage(guildId, doneMessage);
}

export async function runAnalyzeLikeNow(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
    options: {
        expectedMode?: string;
        startLabel: string;
        notRunningLabel: string;
    },
): Promise<void> {
    const session = environment.sessionManager.getSession(guildId);

    if (!session.isRecording) {
        await interaction.reply({
            content: options.notRunningLabel,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (options.expectedMode && session.getActiveAnalysisMode() !== options.expectedMode) {
        await interaction.reply({
            content: `現在起動中なのは ${getModeDisplayName(session.getActiveAnalysisMode())} です。`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.reply({ content: options.startLabel });
    await session.processAudio(true, false);
}
