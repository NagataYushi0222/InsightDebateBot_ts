import { describe, expect, test } from 'bun:test';

// Re-implement the redaction logic for testing since the function is module-private.
const SENSITIVE_KEY_PATTERN = /("(?:secretKey|token|sessionId|session_id|secret_key|authorization)")\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^\s,}\]]+)/gi;

function redactVoiceDebugMessage(message: string): string {
    return message.replace(SENSITIVE_KEY_PATTERN, '$1: "[REDACTED]"');
}

describe('redactVoiceDebugMessage', () => {
    test('redacts secretKey from state dump', () => {
        const message = `state change:\nfrom {"code":4,"connectionData":{"secretKey":[1,2,3,4],"encryptionMode":"aead_aes256_gcm_rtpsize"}}\nto {"code":4}`;
        const result = redactVoiceDebugMessage(message);
        expect(result).not.toContain('[1,2,3,4]');
        expect(result).toContain('"secretKey": "[REDACTED]"');
        expect(result).toContain('"encryptionMode"');
    });

    test('redacts token string value', () => {
        const message = '{"token":"abc123secret","guildId":"12345"}';
        const result = redactVoiceDebugMessage(message);
        expect(result).not.toContain('abc123secret');
        expect(result).toContain('"token": "[REDACTED]"');
        expect(result).toContain('"guildId"');
    });

    test('redacts sessionId', () => {
        const message = '{"sessionId":"sess-secret-id","status":"ready"}';
        const result = redactVoiceDebugMessage(message);
        expect(result).not.toContain('sess-secret-id');
        expect(result).toContain('"sessionId": "[REDACTED]"');
    });

    test('does not modify safe DAVE debug messages', () => {
        const message = 'Failed to decrypt a packet (3 consecutive fails)';
        expect(redactVoiceDebugMessage(message)).toBe(message);
    });

    test('does not modify safe transition messages', () => {
        const message = 'Transition executed (v0 -> v1, id: 5)';
        expect(redactVoiceDebugMessage(message)).toBe(message);
    });

    test('handles multiple sensitive keys in same message', () => {
        const message = '{"token":"tok","secretKey":[255],"sessionId":"sid"}';
        const result = redactVoiceDebugMessage(message);
        expect(result).not.toContain('"tok"');
        expect(result).not.toContain('[255]');
        expect(result).not.toContain('"sid"');
    });
});
