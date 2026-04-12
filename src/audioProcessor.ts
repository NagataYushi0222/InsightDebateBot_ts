import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from './config';

/**
 * FFmpegを使用してPCMファイルをMP3に変換する
 * Discord PCM: s16le, 48000Hz, 2ch
 */
export function convertToMp3(filePath: string): string | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const mp3Path = filePath.replace(/\.\w+$/, '.mp3');

        // まず同梱 ffmpeg を使い、なければサーバーに入っている ffmpeg を使う。
        let ffmpegPath: string;
        try {
            ffmpegPath = require('ffmpeg-static') as string;
        } catch {
            ffmpegPath = 'ffmpeg'; // fallback to system ffmpeg
        }

        if (filePath.endsWith('.pcm')) {
            // 生 PCM はヘッダがないので、サンプル形式を ffmpeg に明示する必要がある。
            execSync(
                `"${ffmpegPath}" -f s16le -ar 48000 -ac 2 -i "${filePath}" -y "${mp3Path}"`,
                { stdio: 'pipe' }
            );
        } else {
            // WAV などヘッダ付きの形式なら ffmpeg に自動判定させる。
            execSync(
                `"${ffmpegPath}" -i "${filePath}" -y "${mp3Path}"`,
                { stdio: 'pipe' }
            );
        }

        return mp3Path;
    } catch (e) {
        console.error(`Error converting ${filePath}:`, e);
        return null;
    }
}

/**
 * 指定されたファイルを削除する
 */
export function cleanupFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                console.error(`Error removing ${filePath}:`, e);
            }
        }
    }
}

/**
 * 一時音声ディレクトリの初期化
 */
export function ensureTempDir(): void {
    if (!fs.existsSync(TEMP_AUDIO_DIR)) {
        fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
    }
}
