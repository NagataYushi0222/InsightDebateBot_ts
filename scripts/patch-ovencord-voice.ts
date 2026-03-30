import fs from 'fs';
import path from 'path';

const targets = [
    path.resolve('node_modules/@ovencord/voice/src/receive/VoiceReceiver.ts'),
    path.resolve('node_modules/@ovencord/voice/src/networking/Networking.ts'),
];

const from = "@noble/ciphers/aes";
const to = "@noble/ciphers/aes.js";

for (const target of targets) {
    if (!fs.existsSync(target)) {
        continue;
    }

    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(from)) {
        continue;
    }

    const next = current.replaceAll(from, to);
    if (next !== current) {
        fs.writeFileSync(target, next, 'utf8');
        console.log(`patched: ${path.relative(process.cwd(), target)}`);
    }
}
