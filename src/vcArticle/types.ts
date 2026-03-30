export interface ArticleTopic {
    id: number;
    title: string;
    summary: string;
    reason: string;
    speakers: string[];
    includesTextChat: boolean;
}

export interface TopicExtractionResult {
    sessionSummary: string;
    topics: ArticleTopic[];
}

export interface TextChatEntry {
    authorName: string;
    content: string;
    timestamp: string;
}
