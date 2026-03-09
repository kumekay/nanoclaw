import { Context } from 'grammy';
import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'gpt-4o-transcribe', // Use gpt-4o-transcribe as requested
  enabled: true,
  fallbackMessage: '[Voice message - transcription unavailable]',
};

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set in .env');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    // Detect MIME type from buffer or default to ogg
    const mimeType = detectMimeType(audioBuffer);

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: mimeType,
    });

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    console.error('OpenAI transcription failed:', err);
    return null;
  }
}

function detectMimeType(buffer: Buffer): string {
  // Check for OGG header
  if (
    buffer.length > 4 &&
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return 'audio/ogg';
  }
  // Check for WAV header
  if (
    buffer.length > 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    return 'audio/wav';
  }
  // Check for MP3 header
  if (buffer.length > 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  // Default to OGG for Telegram voice messages
  return 'audio/ogg';
}

/**
 * Transcribe a Telegram voice message.
 * Downloads the audio file from Telegram servers and sends it to OpenAI.
 */
export async function transcribeTelegramVoice(
  ctx: Context,
  botToken: string,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  const voice = ctx.message?.voice;
  if (!voice) {
    return config.fallbackMessage;
  }

  try {
    // Get the file from Telegram
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    // Download the file
    const response = await fetch(fileUrl);
    if (!response.ok) {
      console.error('Failed to download voice message:', response.statusText);
      return config.fallbackMessage;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded voice message: ${buffer.length} bytes`);

    const transcript = await transcribeWithOpenAI(buffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(ctx: Context): boolean {
  return ctx.message?.voice !== undefined;
}
