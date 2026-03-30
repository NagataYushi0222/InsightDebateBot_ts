import fs from 'fs';
import path from 'path';

type Transform =
    | {
          kind: 'literal';
          from: string;
          to: string;
      }
    | {
          kind: 'regex';
          from: RegExp;
          to: string;
      };

const patches = [
    {
        target: path.resolve('node_modules/@ovencord/voice/src/receive/VoiceReceiver.ts'),
        transforms: <Transform[]>[
            {
                kind: 'literal',
                from: "@noble/ciphers/aes",
                to: "@noble/ciphers/aes.js",
            },
            {
                kind: 'regex',
                from: /const cipher = gcm\(secretKey, nonce\);\s+return cipher\.decrypt\(encryptedWithAuthTag, header\);/g,
                to: "const cipher = gcm(secretKey, nonce, header);\n\t\t\t\treturn cipher.decrypt(encryptedWithAuthTag);",
            },
        ],
    },
    {
        target: path.resolve('node_modules/@ovencord/voice/src/networking/Networking.ts'),
        transforms: <Transform[]>[
            {
                kind: 'literal',
                from: "@noble/ciphers/aes",
                to: "@noble/ciphers/aes.js",
            },
            {
                kind: 'regex',
                from: /const cipher = gcm\(secretKey, connectionData\.nonceBuffer\);\s+encrypted = cipher\.encrypt\(uintPacket, additionalData\);/g,
                to: "const cipher = gcm(secretKey, connectionData.nonceBuffer, additionalData);\n\t\t\t\tencrypted = cipher.encrypt(uintPacket);",
            },
        ],
    },
];

for (const patch of patches) {
    if (!fs.existsSync(patch.target)) {
        continue;
    }

    let current = fs.readFileSync(patch.target, 'utf8');
    let changed = false;

    for (const transform of patch.transforms) {
        if (transform.kind === 'literal') {
            if (!current.includes(transform.from)) {
                continue;
            }
            current = current.replaceAll(transform.from, transform.to);
            changed = true;
            continue;
        }

        if (!transform.from.test(current)) {
            continue;
        }
        current = current.replace(transform.from, transform.to);
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(patch.target, current, 'utf8');
        console.log(`patched: ${path.relative(process.cwd(), patch.target)}`);
    }
}
