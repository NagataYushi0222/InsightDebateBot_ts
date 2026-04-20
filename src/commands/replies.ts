import {
    ChatInputCommandInteraction,
    Message,
    TextChannel,
} from 'discord.js';

export function splitForDiscord(content: string, maxLength: number = 1900): string[] {
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > maxLength) {
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex < Math.floor(maxLength * 0.6)) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.slice(0, splitIndex).trim());
        remaining = remaining.slice(splitIndex).trim();
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}

export async function followUpInChunks(
    interaction: ChatInputCommandInteraction,
    content: string,
): Promise<Message | null> {
    let lastMessage: Message | null = null;
    for (const chunk of splitForDiscord(content)) {
        lastMessage = await interaction.followUp(chunk);
    }
    return lastMessage;
}

export async function replyInChunks(
    interaction: ChatInputCommandInteraction,
    content: string,
): Promise<void> {
    const chunks = splitForDiscord(content);
    await interaction.reply(chunks[0]);

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
    }
}

export async function sendChannelMessageInChunks(
    channel: TextChannel,
    content: string,
): Promise<void> {
    for (const chunk of splitForDiscord(content)) {
        await channel.send(chunk);
    }
}
