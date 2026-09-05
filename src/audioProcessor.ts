import fs from 'fs';

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
