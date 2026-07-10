import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { TEMP_AUDIO_DIR } from './config';

function resolveFfmpegPath(): string {
    try {
        return require('ffmpeg-static') as string;
    } catch {
        return 'ffmpeg';
    }
}

function runFfmpegAsync(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(args[0], args.slice(1), { stdio: 'pipe' });
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-512)}`));
            }
        });
    });
}

/**
 * FFmpegを使用してPCMファイルをMP3に変換する
 * Discord PCM: s16le, 48000Hz, 2ch
 *
 * 非同期版: spawn を使ってイベントループを block しない。
 * 長時間録音（10分超）でも Discord 音声 WebSocket のハートビートが途切れない。
 */
export async function convertToMp3Async(filePath: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const mp3Path = filePath.replace(/\.\w+$/, '.mp3');
    const ffmpegPath = resolveFfmpegPath();

    try {
        if (filePath.endsWith('.pcm')) {
            await runFfmpegAsync([
                ffmpegPath,
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-i', filePath,
                '-y', mp3Path,
            ]);
        } else {
            await runFfmpegAsync([
                ffmpegPath,
                '-i', filePath,
                '-y', mp3Path,
            ]);
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