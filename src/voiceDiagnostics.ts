import { VoiceConnection, VoiceConnectionStatus } from '@ovencord/voice';

interface MutableDaveSession {
    decrypt?: (packet: Uint8Array, userId: string) => Uint8Array | null;
    __voiceDiagnosticsWrapped?: boolean;
}

interface MutableNetworkingState {
    dave?: MutableDaveSession;
}

interface UserCounters {
    daveDecryptFailures: number;
    daveDecryptSuccesses: number;
    opusPacketsReceived: number;
    opusDecodeFailures: number;
    pcmPacketsByConsumer: Map<string, number>;
    pcmBytesByConsumer: Map<string, number>;
}

interface UserCountersSnapshot {
    daveDecryptFailures: number;
    daveDecryptSuccesses: number;
    opusPacketsReceived: number;
    opusDecodeFailures: number;
    pcmPacketsDelivered: number;
    pcmBytesDelivered: number;
}

export interface VoiceConsumerUserStats {
    userId: string;
    daveDecryptFailures: number;
    daveDecryptSuccesses: number;
    opusPacketsReceived: number;
    opusDecodeFailures: number;
    pcmPacketsDelivered: number;
    pcmBytesDelivered: number;
}

export interface VoiceConsumerDiagnosticsSnapshot {
    consumerLabel: string;
    createdAt: string;
    users: VoiceConsumerUserStats[];
}

export interface VoiceLiveConsumerTotals {
    pcmPacketsDelivered: number;
    pcmBytesDelivered: number;
}

export interface VoiceLiveUserStats {
    userId: string;
    daveDecryptFailures: number;
    daveDecryptSuccesses: number;
    opusPacketsReceived: number;
    opusDecodeFailures: number;
    pcmByConsumer: Record<string, VoiceLiveConsumerTotals>;
}

export interface VoiceLiveTotals {
    userCount: number;
    daveDecryptFailures: number;
    daveDecryptSuccesses: number;
    opusPacketsReceived: number;
    opusDecodeFailures: number;
    pcmByConsumer: Record<string, VoiceLiveConsumerTotals>;
}

export interface VoiceConnectionLiveSnapshot {
    createdAt: string;
    users: VoiceLiveUserStats[];
    totals: VoiceLiveTotals;
}

function emptyCounters(): UserCounters {
    return {
        daveDecryptFailures: 0,
        daveDecryptSuccesses: 0,
        opusPacketsReceived: 0,
        opusDecodeFailures: 0,
        pcmPacketsByConsumer: new Map(),
        pcmBytesByConsumer: new Map(),
    };
}

function cloneCounterSnapshot(counter: UserCounters, consumerLabel: string): UserCountersSnapshot {
    return {
        daveDecryptFailures: counter.daveDecryptFailures,
        daveDecryptSuccesses: counter.daveDecryptSuccesses,
        opusPacketsReceived: counter.opusPacketsReceived,
        opusDecodeFailures: counter.opusDecodeFailures,
        pcmPacketsDelivered: counter.pcmPacketsByConsumer.get(consumerLabel) || 0,
        pcmBytesDelivered: counter.pcmBytesByConsumer.get(consumerLabel) || 0,
    };
}

function cloneConsumerTotals(counter: UserCounters): Record<string, VoiceLiveConsumerTotals> {
    const labels = new Set<string>([
        ...counter.pcmPacketsByConsumer.keys(),
        ...counter.pcmBytesByConsumer.keys(),
    ]);
    const result: Record<string, VoiceLiveConsumerTotals> = {};

    for (const label of labels) {
        result[label] = {
            pcmPacketsDelivered: counter.pcmPacketsByConsumer.get(label) || 0,
            pcmBytesDelivered: counter.pcmBytesByConsumer.get(label) || 0,
        };
    }

    return result;
}

class VoiceConnectionDiagnostics {
    private readonly countersByUser = new Map<string, UserCounters>();

    constructor(private readonly connection: VoiceConnection) {}

    ensureDaveInstrumentation(): void {
        if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
            return;
        }

        const networkingState = this.connection.state.networking.state as MutableNetworkingState;
        const daveSession = networkingState.dave;
        if (!daveSession?.decrypt || daveSession.__voiceDiagnosticsWrapped) {
            return;
        }

        const originalDecrypt = daveSession.decrypt.bind(daveSession);
        daveSession.decrypt = (packet: Uint8Array, userId: string) => {
            try {
                const decrypted = originalDecrypt(packet, userId);
                if (decrypted) {
                    this.getUserCounters(userId).daveDecryptSuccesses += 1;
                } else {
                    this.getUserCounters(userId).daveDecryptFailures += 1;
                }
                return decrypted;
            } catch (error) {
                this.getUserCounters(userId).daveDecryptFailures += 1;
                throw error;
            }
        };
        daveSession.__voiceDiagnosticsWrapped = true;
    }

    recordOpusPacket(userId: string): void {
        this.getUserCounters(userId).opusPacketsReceived += 1;
    }

    recordOpusDecodeFailure(userId: string): void {
        this.getUserCounters(userId).opusDecodeFailures += 1;
    }

    recordPcmDelivery(userId: string, consumerLabel: string, byteLength: number): void {
        const counters = this.getUserCounters(userId);
        counters.pcmPacketsByConsumer.set(
            consumerLabel,
            (counters.pcmPacketsByConsumer.get(consumerLabel) || 0) + 1,
        );
        counters.pcmBytesByConsumer.set(
            consumerLabel,
            (counters.pcmBytesByConsumer.get(consumerLabel) || 0) + byteLength,
        );
    }

    captureSnapshot(consumerLabel: string): Map<string, UserCountersSnapshot> {
        const snapshot = new Map<string, UserCountersSnapshot>();
        for (const [userId, counters] of this.countersByUser.entries()) {
            snapshot.set(userId, cloneCounterSnapshot(counters, consumerLabel));
        }
        return snapshot;
    }

    buildConsumerSnapshot(
        consumerLabel: string,
        baseline: Map<string, UserCountersSnapshot> | null,
    ): VoiceConsumerDiagnosticsSnapshot {
        const users = new Set<string>([
            ...this.countersByUser.keys(),
            ...(baseline ? baseline.keys() : []),
        ]);

        const snapshotUsers: VoiceConsumerUserStats[] = Array.from(users)
            .sort()
            .map((userId) => {
                const currentCounters = this.countersByUser.get(userId);
                const current = currentCounters
                    ? cloneCounterSnapshot(currentCounters, consumerLabel)
                    : {
                          daveDecryptFailures: 0,
                          daveDecryptSuccesses: 0,
                          opusPacketsReceived: 0,
                          opusDecodeFailures: 0,
                          pcmPacketsDelivered: 0,
                          pcmBytesDelivered: 0,
                      };
                const previous = baseline?.get(userId) || {
                    daveDecryptFailures: 0,
                    daveDecryptSuccesses: 0,
                    opusPacketsReceived: 0,
                    opusDecodeFailures: 0,
                    pcmPacketsDelivered: 0,
                    pcmBytesDelivered: 0,
                };

                return {
                    userId,
                    daveDecryptFailures: current.daveDecryptFailures - previous.daveDecryptFailures,
                    daveDecryptSuccesses: current.daveDecryptSuccesses - previous.daveDecryptSuccesses,
                    opusPacketsReceived: current.opusPacketsReceived - previous.opusPacketsReceived,
                    opusDecodeFailures: current.opusDecodeFailures - previous.opusDecodeFailures,
                    pcmPacketsDelivered: current.pcmPacketsDelivered - previous.pcmPacketsDelivered,
                    pcmBytesDelivered: current.pcmBytesDelivered - previous.pcmBytesDelivered,
                };
            })
            .filter((user) =>
                user.daveDecryptFailures > 0
                || user.daveDecryptSuccesses > 0
                || user.opusPacketsReceived > 0
                || user.opusDecodeFailures > 0
                || user.pcmPacketsDelivered > 0
                || user.pcmBytesDelivered > 0
            );

        return {
            consumerLabel,
            createdAt: new Date().toISOString(),
            users: snapshotUsers,
        };
    }

    buildLiveSnapshot(): VoiceConnectionLiveSnapshot {
        const users = Array.from(this.countersByUser.entries())
            .sort(([leftUserId], [rightUserId]) => leftUserId.localeCompare(rightUserId))
            .map(([userId, counters]) => ({
                userId,
                daveDecryptFailures: counters.daveDecryptFailures,
                daveDecryptSuccesses: counters.daveDecryptSuccesses,
                opusPacketsReceived: counters.opusPacketsReceived,
                opusDecodeFailures: counters.opusDecodeFailures,
                pcmByConsumer: cloneConsumerTotals(counters),
            }));

        const totals: VoiceLiveTotals = {
            userCount: users.length,
            daveDecryptFailures: 0,
            daveDecryptSuccesses: 0,
            opusPacketsReceived: 0,
            opusDecodeFailures: 0,
            pcmByConsumer: {},
        };

        for (const user of users) {
            totals.daveDecryptFailures += user.daveDecryptFailures;
            totals.daveDecryptSuccesses += user.daveDecryptSuccesses;
            totals.opusPacketsReceived += user.opusPacketsReceived;
            totals.opusDecodeFailures += user.opusDecodeFailures;

            for (const [consumerLabel, consumerTotals] of Object.entries(user.pcmByConsumer)) {
                const current = totals.pcmByConsumer[consumerLabel] || {
                    pcmPacketsDelivered: 0,
                    pcmBytesDelivered: 0,
                };
                current.pcmPacketsDelivered += consumerTotals.pcmPacketsDelivered;
                current.pcmBytesDelivered += consumerTotals.pcmBytesDelivered;
                totals.pcmByConsumer[consumerLabel] = current;
            }
        }

        return {
            createdAt: new Date().toISOString(),
            users,
            totals,
        };
    }

    private getUserCounters(userId: string): UserCounters {
        let counters = this.countersByUser.get(userId);
        if (!counters) {
            counters = emptyCounters();
            this.countersByUser.set(userId, counters);
        }
        return counters;
    }
}

const diagnosticsByConnection = new WeakMap<VoiceConnection, VoiceConnectionDiagnostics>();

export function ensureVoiceConnectionDiagnostics(connection: VoiceConnection): VoiceConnectionDiagnostics {
    let diagnostics = diagnosticsByConnection.get(connection);
    if (!diagnostics) {
        diagnostics = new VoiceConnectionDiagnostics(connection);
        diagnosticsByConnection.set(connection, diagnostics);
    }

    diagnostics.ensureDaveInstrumentation();
    return diagnostics;
}

export function getVoiceConnectionLiveSnapshot(connection: VoiceConnection): VoiceConnectionLiveSnapshot {
    return ensureVoiceConnectionDiagnostics(connection).buildLiveSnapshot();
}
