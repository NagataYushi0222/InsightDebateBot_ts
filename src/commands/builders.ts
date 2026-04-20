import {
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { buildAnalyzeCommands, buildDialogueCommands } from './builders/analyze';
import { buildArticleCommands } from './builders/article';
import { buildSharedUtilityCommands } from './builders/shared';

type CommandBuilder =
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;

export function buildBotCommands(options: {
    includeDialogue?: boolean;
    includeArticle?: boolean;
} = {}): CommandBuilder[] {
    const {
        includeDialogue = false,
        includeArticle = false,
    } = options;

    return [
        ...buildAnalyzeCommands(),
        ...(includeDialogue ? buildDialogueCommands() : []),
        ...(includeArticle ? buildArticleCommands() : []),
        ...buildSharedUtilityCommands(),
    ];
}
