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
export const GEMINI_MODEL_FLASH = 'gemini-2.5-flash';
export const GEMINI_MODEL_3_FLASH = 'gemini-3-flash-preview';
export const DEFAULT_MODEL = GEMINI_MODEL_3_FLASH;

// Paths
export const TEMP_AUDIO_DIR = 'temp_audio';
