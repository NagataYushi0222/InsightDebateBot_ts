import { VoiceConnection, VoiceConnectionStatus } from '@ovencord/voice';
import { Guild } from 'discord.js';
import { cleanupFiles } from './audioProcessor';
import { UserAudioRecorder } from './recorder';
import { attachVoiceCaptureConsumer } from './voiceCaptureHub';

const RETENTION_MS = 10 * 60 * 1000;
const CHUNK_MS = 60 * 1000;

export interface ImakitaAudioClip { userId: string; displayName: string; filePath: string; capturedAt: number; }

export class ImakitaSession {
    public voiceConnection: VoiceConnection | null = null;
    public isRecording = false;
    private recorder: UserAudioRecorder | null = null;
    private detach: (() => void) | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushing: Promise<void> = Promise.resolve();
    private clips: ImakitaAudioClip[] = [];
    private users = new Map<string, string>();

    hasActiveConnection(): boolean { return !!this.voiceConnection && this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed; }

    async start(connection: VoiceConnection, guild: Guild): Promise<void> {
        this.voiceConnection = connection;
        this.recorder = new UserAudioRecorder();
        this.isRecording = true;
        this.users.clear();
        guild.members.cache.forEach((member) => { if (!member.user.bot && member.voice.channelId === connection.joinConfig.channelId) this.users.set(member.id, member.displayName); });
        this.detach = attachVoiceCaptureConsumer(connection, {
            consumerLabel: `imakita:${guild.id}`,
            onSpeakerStart: (id) => { const member = guild.members.cache.get(id); if (member) this.users.set(id, member.displayName); },
            onOpus: (id, opus) => { if (this.isRecording && this.recorder) this.recorder.writeOpus(id, opus); },
        });
        this.timer = setInterval(() => {
            void this.flush().catch((error) => console.error('[Imakita] Failed to flush audio chunk:', error));
        }, CHUNK_MS);
    }

    private async flush(): Promise<void> {
        this.flushing = this.flushing.then(async () => {
            const raw = await this.recorder?.flushAudio() || new Map<string, string>();
            const now = Date.now();
            for (const [userId, filePath] of raw) this.clips.push({ userId, displayName: this.users.get(userId) || `User_${userId}`, filePath, capturedAt: now });
            const expired = this.clips.filter((clip) => clip.capturedAt < now - RETENTION_MS);
            this.clips = this.clips.filter((clip) => clip.capturedAt >= now - RETENTION_MS);
            cleanupFiles(expired.map((clip) => clip.filePath));
        });
        await this.flushing;
    }

    async getRecentClips(): Promise<ImakitaAudioClip[]> {
        await this.flush();
        return [...this.clips];
    }

    async stop(destroyConnection: boolean): Promise<void> {
        this.isRecording = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.detach?.(); this.detach = null;
        const connection = this.voiceConnection; this.voiceConnection = null;
        const recorder = this.recorder;
        try {
            await this.flush();
        } finally {
            await recorder?.discard();
            cleanupFiles(this.clips.map((clip) => clip.filePath));
            this.clips = [];
            this.recorder = null;
            if (destroyConnection && connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
        }
    }

    handleDestroyedConnection(connection: VoiceConnection): boolean {
        if (this.voiceConnection !== connection) return false;

        this.isRecording = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.detach?.();
        this.detach = null;
        this.voiceConnection = null;

        const recorder = this.recorder;
        this.recorder = null;
        void this.flushing
            .catch(() => undefined)
            .then(() => recorder?.discard())
            .then(() => {
                cleanupFiles(this.clips.map((clip) => clip.filePath));
                this.clips = [];
            })
            .catch((error) => console.error('[Imakita] Failed to discard destroyed recording:', error));
        return true;
    }
}

export class ImakitaSessionManager {
    private sessions = new Map<string, ImakitaSession>();
    getSession(guildId: string): ImakitaSession { let s = this.sessions.get(guildId); if (!s) { s = new ImakitaSession(); this.sessions.set(guildId, s); } return s; }
    getExistingSession(guildId: string): ImakitaSession | null { return this.sessions.get(guildId) || null; }
    cleanupDestroyedConnection(guildId: string, connection: VoiceConnection): void {
        const session = this.sessions.get(guildId);
        if (session?.handleDestroyedConnection(connection)) this.sessions.delete(guildId);
    }
}
