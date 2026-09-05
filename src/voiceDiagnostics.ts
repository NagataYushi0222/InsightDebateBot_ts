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
}

export interface VoiceConsumerUserStats extends UserCounters {
    userId: string;
}

export interface VoiceConsumerDiagnosticsSnapshot {
    consumerLabel: string;
    createdAt: string;
    users: VoiceConsumerUserStats[];
}

export interface VoiceLiveUserStats extends VoiceConsumerUserStats {}

export interface VoiceLiveTotals extends UserCounters {
    userCount: number;
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
    };
}

function cloneCounters(counter: UserCounters): UserCounters {
    return { ...counter };
}

class VoiceConnectionDiagnostics {
    private readonly countersByUser = new Map<string, UserCounters>();

    constructor(private readonly connection: VoiceConnection) {}

    ensureDaveInstrumentation(): void {
        if (this.connection.state.status !== VoiceConnectionStatus.Ready) return;

        const networkingState = this.connection.state.networking.state as MutableNetworkingState;
        const daveSession = networkingState.dave;
        if (!daveSession?.decrypt || daveSession.__voiceDiagnosticsWrapped) return;

        const originalDecrypt = daveSession.decrypt.bind(daveSession);
        daveSession.decrypt = (packet: Uint8Array, userId: string) => {
            try {
                const decrypted = originalDecrypt(packet, userId);
                if (decrypted) this.getUserCounters(userId).daveDecryptSuccesses += 1;
                else this.getUserCounters(userId).daveDecryptFailures += 1;
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

    captureSnapshot(_consumerLabel: string): Map<string, UserCounters> {
        return new Map(
            Array.from(this.countersByUser, ([userId, counters]) => [userId, cloneCounters(counters)]),
        );
    }

    buildConsumerSnapshot(
        consumerLabel: string,
        baseline: Map<string, UserCounters> | null,
    ): VoiceConsumerDiagnosticsSnapshot {
        const userIds = new Set([
            ...this.countersByUser.keys(),
            ...(baseline?.keys() ?? []),
        ]);
        const users = Array.from(userIds)
            .sort()
            .map((userId) => {
                const current = this.countersByUser.get(userId) ?? emptyCounters();
                const previous = baseline?.get(userId) ?? emptyCounters();
                return {
                    userId,
                    daveDecryptFailures: current.daveDecryptFailures - previous.daveDecryptFailures,
                    daveDecryptSuccesses: current.daveDecryptSuccesses - previous.daveDecryptSuccesses,
                    opusPacketsReceived: current.opusPacketsReceived - previous.opusPacketsReceived,
                };
            })
            .filter((user) =>
                user.daveDecryptFailures > 0
                || user.daveDecryptSuccesses > 0
                || user.opusPacketsReceived > 0
            );

        return { consumerLabel, createdAt: new Date().toISOString(), users };
    }

    buildLiveSnapshot(): VoiceConnectionLiveSnapshot {
        const users = Array.from(this.countersByUser.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([userId, counters]) => ({ userId, ...cloneCounters(counters) }));
        const totals: VoiceLiveTotals = {
            userCount: users.length,
            ...emptyCounters(),
        };

        for (const user of users) {
            totals.daveDecryptFailures += user.daveDecryptFailures;
            totals.daveDecryptSuccesses += user.daveDecryptSuccesses;
            totals.opusPacketsReceived += user.opusPacketsReceived;
        }
        return { createdAt: new Date().toISOString(), users, totals };
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
