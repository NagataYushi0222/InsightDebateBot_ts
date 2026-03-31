import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from '../config';
import { TextChatEntry, TopicExtractionResult } from './types';

const ARTICLE_ARCHIVE_ROOT = path.resolve(TEMP_AUDIO_DIR, 'vc_article_archive');
const ARCHIVE_RETENTION_DAYS = 7;
const RETENTION_MS = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface StoredAudioClip {
    clipId: string;
    userId: string;
    displayName: string;
    filePath: string;
}

interface ArchivedAudioFile {
    clipId: string;
    userId: string;
    fileName: string;
    displayName: string;
    relativePath: string;
    sizeBytes: number;
}

interface ArchivedSessionMetadata {
    archiveId: string;
    guildId: string;
    voiceChannelName: string;
    createdAt: string;
    dateKey: string;
    summaryLabel?: string;
    topicResult?: TopicExtractionResult;
    audioFiles: ArchivedAudioFile[];
    textEntries: TextChatEntry[];
}

export interface ArchivedSessionSummary {
    archiveId: string;
    createdAt: string;
    dateKey: string;
    voiceChannelName: string;
    summaryLabel: string | null;
    speakerCount: number;
    fileCount: number;
    textEntryCount: number;
    totalBytes: number;
}

export interface LoadedArchivedSession {
    archiveId: string;
    createdAt: string;
    voiceChannelName: string;
    summaryLabel: string | null;
    topicResult: TopicExtractionResult | null;
    audioClips: StoredAudioClip[];
    textEntries: TextChatEntry[];
}

function ensureArchiveRoot(): void {
    if (!fs.existsSync(ARTICLE_ARCHIVE_ROOT)) {
        fs.mkdirSync(ARTICLE_ARCHIVE_ROOT, { recursive: true });
    }
}

function removeDirectoryIfExists(targetPath: string): void {
    if (!fs.existsSync(targetPath)) return;
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function formatDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatArchiveId(date: Date, guildId: string): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}${m}${d}_${hh}${mm}${ss}_${guildId}`;
}

function getSessionDir(dateKey: string, archiveId: string): string {
    return path.join(ARTICLE_ARCHIVE_ROOT, dateKey, archiveId);
}

function getMetadataPath(dateKey: string, archiveId: string): string {
    return path.join(getSessionDir(dateKey, archiveId), 'metadata.json');
}

function writeMetadata(metadata: ArchivedSessionMetadata): void {
    const metadataPath = getMetadataPath(metadata.dateKey, metadata.archiveId);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}

function readMetadata(metadataPath: string): ArchivedSessionMetadata {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ArchivedSessionMetadata;
}

function sanitizeFileSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildSummaryLabel(summary: string, maxLength: number = 20): string {
    const normalized = summary.replace(/\s+/g, ' ').trim();
    if (!normalized) return '概要未設定';
    return normalized.length <= maxLength
        ? normalized
        : `${normalized.slice(0, maxLength)}...`;
}

function collectMetadataPaths(): string[] {
    if (!fs.existsSync(ARTICLE_ARCHIVE_ROOT)) return [];

    const metadataPaths: string[] = [];
    for (const dateDir of fs.readdirSync(ARTICLE_ARCHIVE_ROOT, { withFileTypes: true })) {
        if (!dateDir.isDirectory()) continue;

        const datePath = path.join(ARTICLE_ARCHIVE_ROOT, dateDir.name);
        for (const sessionDir of fs.readdirSync(datePath, { withFileTypes: true })) {
            if (!sessionDir.isDirectory()) continue;

            const metadataPath = path.join(datePath, sessionDir.name, 'metadata.json');
            if (fs.existsSync(metadataPath)) {
                metadataPaths.push(metadataPath);
            }
        }
    }

    return metadataPaths;
}

function isExpired(createdAt: string, nowMs: number = Date.now()): boolean {
    const createdAtMs = new Date(createdAt).getTime();
    if (Number.isNaN(createdAtMs)) return false;
    return nowMs - createdAtMs >= RETENTION_MS;
}

export function cleanupExpiredArchives(): number {
    ensureArchiveRoot();

    let removedCount = 0;
    const nowMs = Date.now();

    for (const metadataPath of collectMetadataPaths()) {
        try {
            const metadata = readMetadata(metadataPath);
            if (!isExpired(metadata.createdAt, nowMs)) continue;

            removeDirectoryIfExists(path.dirname(metadataPath));
            removedCount += 1;
        } catch {
            // ignore broken archive metadata
        }
    }

    for (const dateDir of fs.readdirSync(ARTICLE_ARCHIVE_ROOT, { withFileTypes: true })) {
        if (!dateDir.isDirectory()) continue;
        const datePath = path.join(ARTICLE_ARCHIVE_ROOT, dateDir.name);
        if (fs.readdirSync(datePath).length === 0) {
            removeDirectoryIfExists(datePath);
        }
    }

    return removedCount;
}

export function saveArchivedSession(params: {
    guildId: string;
    voiceChannelName: string;
    audioClips: StoredAudioClip[];
    textEntries: TextChatEntry[];
    createdAt?: Date;
}): LoadedArchivedSession {
    ensureArchiveRoot();
    cleanupExpiredArchives();

    const createdAt = params.createdAt || new Date();
    const dateKey = formatDateKey(createdAt);
    const archiveId = formatArchiveId(createdAt, params.guildId);
    const sessionDir = getSessionDir(dateKey, archiveId);

    fs.mkdirSync(sessionDir, { recursive: true });

    const audioFiles: ArchivedAudioFile[] = [];
    const persistedAudioClips: StoredAudioClip[] = [];

    for (const clip of params.audioClips) {
        const { clipId, userId, displayName, filePath: sourcePath } = clip;
        if (!fs.existsSync(sourcePath)) continue;

        const safeName = sanitizeFileSegment(displayName);
        const destinationName = `${safeName}_${userId}_${clipId}.mp3`;
        const destinationPath = path.join(sessionDir, destinationName);
        fs.renameSync(sourcePath, destinationPath);

        const relativePath = path.relative(sessionDir, destinationPath);
        const sizeBytes = fs.statSync(destinationPath).size;

        audioFiles.push({
            clipId,
            userId,
            fileName: destinationName,
            displayName,
            relativePath,
            sizeBytes,
        });
        persistedAudioClips.push({
            clipId,
            userId,
            displayName,
            filePath: destinationPath,
        });
    }

    const metadata: ArchivedSessionMetadata = {
        archiveId,
        guildId: params.guildId,
        voiceChannelName: params.voiceChannelName,
        createdAt: createdAt.toISOString(),
        dateKey,
        audioFiles,
        textEntries: params.textEntries,
    };

    writeMetadata(metadata);

    return {
        archiveId,
        createdAt: metadata.createdAt,
        voiceChannelName: metadata.voiceChannelName,
        summaryLabel: metadata.summaryLabel || null,
        topicResult: metadata.topicResult || null,
        audioClips: persistedAudioClips,
        textEntries: params.textEntries,
    };
}

export function updateArchivedSessionSummaryLabel(archiveId: string, summary: string): string {
    cleanupExpiredArchives();
    const metadataPath = collectMetadataPaths().find((candidate) => {
        try {
            const metadata = readMetadata(candidate);
            return metadata.archiveId === archiveId;
        } catch {
            return false;
        }
    });

    if (!metadataPath) {
        throw new Error(`保存済み音声 ${archiveId} が見つかりませんでした。`);
    }

    const metadata = readMetadata(metadataPath);
    const summaryLabel = buildSummaryLabel(summary);
    metadata.summaryLabel = summaryLabel;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    return summaryLabel;
}

export function updateArchivedSessionTopicResult(
    archiveId: string,
    topicResult: TopicExtractionResult,
): void {
    cleanupExpiredArchives();
    const metadataPath = collectMetadataPaths().find((candidate) => {
        try {
            const metadata = readMetadata(candidate);
            return metadata.archiveId === archiveId;
        } catch {
            return false;
        }
    });

    if (!metadataPath) {
        throw new Error(`保存済み音声 ${archiveId} が見つかりませんでした。`);
    }

    const metadata = readMetadata(metadataPath);
    metadata.topicResult = topicResult;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}

export function listArchivedSessions(limit: number = 20, guildId?: string): ArchivedSessionSummary[] {
    cleanupExpiredArchives();
    const summaries = collectMetadataPaths()
        .map((metadataPath) => {
            const metadata = readMetadata(metadataPath);
            if (guildId && metadata.guildId !== guildId) {
                return null;
            }
            const totalBytes = metadata.audioFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
            return {
                archiveId: metadata.archiveId,
                createdAt: metadata.createdAt,
                dateKey: metadata.dateKey,
                voiceChannelName: metadata.voiceChannelName,
                summaryLabel: metadata.summaryLabel || null,
                speakerCount: new Set(metadata.audioFiles.map((file) => file.userId)).size,
                fileCount: metadata.audioFiles.length,
                textEntryCount: metadata.textEntries.length,
                totalBytes,
            } satisfies ArchivedSessionSummary;
        })
        .filter((summary): summary is ArchivedSessionSummary => summary !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return summaries.slice(0, limit);
}

export function loadArchivedSession(archiveId: string, guildId?: string): LoadedArchivedSession {
    cleanupExpiredArchives();
    const metadataPath = collectMetadataPaths().find((candidate) => {
        try {
            const metadata = readMetadata(candidate);
            return metadata.archiveId === archiveId;
        } catch {
            return false;
        }
    });

    if (!metadataPath) {
        throw new Error(`保存済み音声 ${archiveId} が見つかりませんでした。`);
    }

    const metadata = readMetadata(metadataPath);
    if (guildId && metadata.guildId !== guildId) {
        throw new Error(`保存済み音声 ${archiveId} はこのサーバーでは利用できません。`);
    }
    const sessionDir = path.dirname(metadataPath);
    const audioClips: StoredAudioClip[] = [];

    for (const file of metadata.audioFiles) {
        const absolutePath = path.resolve(sessionDir, file.relativePath);
        if (!fs.existsSync(absolutePath)) continue;
        audioClips.push({
            clipId: file.clipId,
            userId: file.userId,
            displayName: file.displayName,
            filePath: absolutePath,
        });
    }

    return {
        archiveId: metadata.archiveId,
        createdAt: metadata.createdAt,
        voiceChannelName: metadata.voiceChannelName,
        summaryLabel: metadata.summaryLabel || null,
        topicResult: metadata.topicResult || null,
        audioClips,
        textEntries: metadata.textEntries || [],
    };
}

export function getArchiveRoot(): string {
    ensureArchiveRoot();
    cleanupExpiredArchives();
    return ARTICLE_ARCHIVE_ROOT;
}
