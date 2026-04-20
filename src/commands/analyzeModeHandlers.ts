import { ChatInputCommandInteraction } from 'discord.js';
import { getGuildSettings } from '../database';
import {
    AnalyzeModeEnvironment,
    runAnalyzeLikeNow,
    startAnalyzeLikeSession,
    stopAnalyzeLikeSession,
} from './analyzeModes';
import { AnalyzeLikeModeConfig, analyzeLikeModeConfigs } from './analyzeModeConfigs';

function getAnalyzeModeConfig(kind: 'analyze' | 'dialogue'): AnalyzeLikeModeConfig {
    return analyzeLikeModeConfigs[kind];
}

export async function handleConfiguredAnalyzeStart(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
): Promise<void> {
    const settings = getGuildSettings(guildId);
    const mode = settings.analysis_mode || 'debate';
    const config = getAnalyzeModeConfig('analyze');

    await startAnalyzeLikeSession(interaction, guildId, environment, {
        mode,
        initialMessageBuilder: config.buildInitialMessage,
    });
}

export async function handleConfiguredDialogueStart(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
): Promise<void> {
    const theme = interaction.options.getString('theme', true).trim();
    const config = getAnalyzeModeConfig('dialogue');

    await startAnalyzeLikeSession(interaction, guildId, environment, {
        mode: 'dialogue',
        dialogueTheme: theme,
        initialMessageBuilder: config.buildInitialMessage,
    });
}

export async function handleConfiguredAnalyzeLikeStop(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
    kind: 'analyze' | 'dialogue',
    skipFinal: boolean,
): Promise<void> {
    const config = getAnalyzeModeConfig(kind);

    await stopAnalyzeLikeSession(interaction, guildId, environment, {
        expectedMode: config.expectedMode,
        skipFinal,
        stoppingLabel: skipFinal ? '' : config.stopFinal.stoppingLabel,
        doneLabel: skipFinal ? config.stop.doneLabel : config.stopFinal.doneLabel,
        notRunningLabel: skipFinal ? config.stop.notRunningLabel : config.stopFinal.notRunningLabel,
        cleanupReason: skipFinal ? config.stop.cleanupReason : config.stopFinal.cleanupReason,
    });
}

export async function handleConfiguredAnalyzeLikeNow(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    environment: AnalyzeModeEnvironment,
    kind: 'analyze' | 'dialogue',
): Promise<void> {
    const config = getAnalyzeModeConfig(kind);

    await runAnalyzeLikeNow(interaction, guildId, environment, {
        expectedMode: config.expectedMode,
        startLabel: config.now.startLabel,
        notRunningLabel: config.now.notRunningLabel,
    });
}
