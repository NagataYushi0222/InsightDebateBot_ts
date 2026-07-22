import dotenv from 'dotenv';
dotenv.config();

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GUILD_ID = process.env.GUILD_ID || '';

// Audio settings
export const RECORDING_INTERVAL = 300; // seconds
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;

// Models
export const GEMINI_MODEL_36_FLASH = 'gemini-3.6-flash';
export const GEMINI_MODEL_35_FLASH_LITE = 'gemini-3.5-flash-lite';
export const DEFAULT_MODEL = GEMINI_MODEL_36_FLASH;

export const DEPRECATED_MODEL_REPLACEMENTS: Record<string, string> = {
    'gemini-3.5-flash': GEMINI_MODEL_36_FLASH,
    'gemini-3-flash-preview': GEMINI_MODEL_36_FLASH,
    'gemini-2.5-flash': GEMINI_MODEL_36_FLASH,
    'gemini-3.1-flash-lite': GEMINI_MODEL_35_FLASH_LITE,
    'gemini-3.1-flash-lite-preview': GEMINI_MODEL_35_FLASH_LITE,
    'gemini-2.5-flash-lite': GEMINI_MODEL_35_FLASH_LITE,
};

export function resolveGeminiModel(modelName: string | null | undefined): string {
    const normalized = modelName?.trim();
    if (!normalized) return DEFAULT_MODEL;
    return DEPRECATED_MODEL_REPLACEMENTS[normalized] || normalized;
}

export function getGeminiModelDisplayName(modelId: string): string {
    switch (modelId) {
        case GEMINI_MODEL_36_FLASH:
            return 'Gemini 3.6 Flash';
        case GEMINI_MODEL_35_FLASH_LITE:
            return 'Gemini 3.5 Flash Lite';
        default:
            return modelId;
    }
}

export function isGeminiThinkingModel(modelName: string): boolean {
    return /^gemini-(?:2\.5|3(?:[.-]|$))/.test(modelName);
}

// Paths
export const TEMP_AUDIO_DIR = 'temp_audio';
