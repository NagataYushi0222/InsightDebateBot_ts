import fs from 'fs';
import { TEMP_AUDIO_DIR } from './config';

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
