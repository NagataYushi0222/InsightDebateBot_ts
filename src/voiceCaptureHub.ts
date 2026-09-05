import {
    AudioReceiveStream,
    EndBehaviorType,
    VoiceConnection,
    VoiceConnectionStatus,
} from '@ovencord/voice';
import { ensureVoiceConnectionDiagnostics } from './voiceDiagnostics';
import type { VoiceConsumerDiagnosticsSnapshot } from './voiceDiagnostics';

export interface VoiceCaptureConsumer {
    consumerLabel: string;
    onOpus(userId: string, opusPacket: Buffer): void;
    onSpeakerStart?(userId: string): void;
    onStats?(stats: VoiceConsumerDiagnosticsSnapshot): void;
}

class VoiceCaptureHub {
    private readonly consumers = new Set<VoiceCaptureConsumer>();
    private readonly activeReaders = new Map<string, ReadableStreamDefaultReader<Uint8Array | null>>();
    private readonly consumerBaselines = new Map<VoiceCaptureConsumer, Map<string, {
        daveDecryptFailures: number;
        daveDecryptSuccesses: number;
        opusPacketsReceived: number;
        opusDecodeFailures: number;
        pcmPacketsDelivered: number;
        pcmBytesDelivered: number;
    }>>();
    private readonly diagnostics;
    private isDisposed = false;

    constructor(
        private readonly connection: VoiceConnection,
        private readonly onDispose: () => void
    ) {
        this.diagnostics = ensureVoiceConnectionDiagnostics(connection);
        this.handleSpeakingStart = this.handleSpeakingStart.bind(this);
        this.handleStateChange = this.handleStateChange.bind(this);

        this.connection.receiver.speaking.on('start', this.handleSpeakingStart);
        this.connection.on('stateChange', this.handleStateChange);
    }

    addConsumer(consumer: VoiceCaptureConsumer): () => void {
        this.consumers.add(consumer);
        this.consumerBaselines.set(
            consumer,
            this.diagnostics.captureSnapshot(consumer.consumerLabel),
        );

        return () => {
            this.emitConsumerStats(consumer);
            this.consumers.delete(consumer);
            this.consumerBaselines.delete(consumer);
            if (this.consumers.size === 0) {
                this.dispose();
            }
        };
    }

    private handleStateChange(_: unknown, newState: { status: VoiceConnectionStatus }): void {
        if (newState.status === VoiceConnectionStatus.Ready) {
            this.diagnostics.ensureDaveInstrumentation();
        }
        if (newState.status === VoiceConnectionStatus.Destroyed) {
            this.dispose();
        }
    }

    private handleSpeakingStart(userId: string): void {
        if (this.isDisposed) {
            return;
        }

        for (const consumer of this.consumers) {
            consumer.onSpeakerStart?.(userId);
        }

        if (this.activeReaders.has(userId)) {
            return;
        }

        const opusStream = this.connection.receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.Manual,
            },
        });

        this.consumeUserStream(userId, opusStream);
    }

    private consumeUserStream(userId: string, opusStream: AudioReceiveStream): void {
        const reader = opusStream.stream.getReader();
        this.activeReaders.set(userId, reader);

        const readLoop = async () => {
            try {
                while (!this.isDisposed) {
                    const { done, value } = await reader.read();
                    if (this.isDisposed || done || !value) {
                        break;
                    }

                    this.diagnostics.recordOpusPacket(userId);
                    const opusPacket = Buffer.from(value);

                    for (const consumer of this.consumers) {
                        try {
                            consumer.onOpus(userId, opusPacket);
                        } catch (error) {
                            console.error(`Voice capture consumer error for ${userId}:`, error);
                        }
                    }
                }
            } catch (error) {
                console.error(`Shared audio stream error for user ${userId}:`, error);
            } finally {
                this.activeReaders.delete(userId);
                try {
                    reader.releaseLock();
                } catch {
                    // ignore release errors during shutdown
                }
            }
        };

        void readLoop();
    }

    private dispose(): void {
        if (this.isDisposed) {
            return;
        }

        this.isDisposed = true;
        this.connection.receiver.speaking.removeListener('start', this.handleSpeakingStart);
        this.connection.removeListener('stateChange', this.handleStateChange);

        for (const consumer of this.consumers) {
            this.emitConsumerStats(consumer);
        }
        for (const reader of this.activeReaders.values()) {
            reader.cancel().catch(() => undefined);
        }
        this.activeReaders.clear();
        this.consumerBaselines.clear();
        this.consumers.clear();
        this.onDispose();
    }

    private emitConsumerStats(consumer: VoiceCaptureConsumer): void {
        const baseline = this.consumerBaselines.get(consumer) || null;
        const snapshot = this.diagnostics.buildConsumerSnapshot(consumer.consumerLabel, baseline);
        consumer.onStats?.(snapshot);
    }
}

const hubs = new WeakMap<VoiceConnection, VoiceCaptureHub>();

export function attachVoiceCaptureConsumer(
    connection: VoiceConnection,
    consumer: VoiceCaptureConsumer
): () => void {
    let hub = hubs.get(connection);
    if (!hub) {
        hub = new VoiceCaptureHub(connection, () => {
            hubs.delete(connection);
        });
        hubs.set(connection, hub);
    }

    return hub.addConsumer(consumer);
}
