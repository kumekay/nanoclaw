/**
 * Audio transcription using OpenAI gpt-4o-transcribe model.
 * Downloads audio from Telegram, extracts audio from video via ffmpeg,
 * and sends to OpenAI for transcription.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

function getOpenAIKey(): string | undefined {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  return process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY || undefined;
}

/**
 * Transcribe an audio buffer using OpenAI's gpt-4o-transcribe model.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — cannot transcribe audio');
    return null;
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), filename);
    formData.append('model', 'gpt-4o-transcribe');

    const response = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText },
        'OpenAI transcription failed',
      );
      return null;
    }

    const result = (await response.json()) as { text?: string };
    logger.info(
      { chars: result.text?.length ?? 0, filename },
      'Transcribed audio message',
    );
    return result.text || null;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription request failed');
    return null;
  }
}

/**
 * Extract audio track from a video file using ffmpeg.
 * Returns an OGG/Opus audio buffer, or null if ffmpeg fails.
 */
export async function extractAudioFromVideo(
  videoBuffer: Buffer,
  inputExt: string,
): Promise<Buffer | null> {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const videoPath = path.join(tmpDir, `nanoclaw-video-${ts}${inputExt}`);
  const audioPath = path.join(tmpDir, `nanoclaw-audio-${ts}.ogg`);

  try {
    fs.writeFileSync(videoPath, videoBuffer);
    await execFileAsync('ffmpeg', [
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'libopus',
      '-y',
      audioPath,
    ]);
    return fs.readFileSync(audioPath);
  } catch (err) {
    logger.error({ err }, 'Failed to extract audio from video with ffmpeg');
    return null;
  } finally {
    try {
      fs.unlinkSync(videoPath);
    } catch {}
    try {
      fs.unlinkSync(audioPath);
    } catch {}
  }
}

/**
 * Download a file from Telegram's file server.
 */
export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
): Promise<Buffer | null> {
  try {
    const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) {
      logger.error(
        { status: response.status, filePath },
        'Failed to download Telegram file',
      );
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    logger.error({ err, filePath }, 'Telegram file download failed');
    return null;
  }
}
