/**
 * Image captioning via OpenAI vision-capable chat completions.
 *
 * Used by the diary topic handler to generate search-friendly Russian alt
 * text for photos. Mirrors the shape of `transcription.ts`: returns null on
 * failure, never throws, and reads OPENAI_API_KEY from env or .env.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

/** Russian system prompt: tuned for full-text-search-friendly diary captions. */
const SYSTEM_PROMPT =
  'Опиши это изображение по-русски в 1–2 предложениях так, чтобы по описанию его можно было найти полнотекстовым поиском. ' +
  'Перечисли видимые объекты, людей, действия, обстановку, цвета, текст на изображении (если читается). Используй конкретные термины. ' +
  'Бренды, имена собственные, технические термины и надписи на иностранных языках сохраняй в оригинале. ' +
  'Не добавляй вступлений вроде «На изображении…» — сразу описание. Ответь только текстом описания, без кавычек и пояснений.';

export interface DescribeImageOptions {
  mimeType: string;
  /** OpenAI vision-capable model id. Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
}

function getOpenAIKey(): string | undefined {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  return process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY || undefined;
}

/**
 * Generate a search-friendly Russian alt-text caption for a single image.
 * Returns null on any failure (missing key, network error, non-200, empty response).
 */
export async function describeImage(
  imageBuffer: Buffer,
  opts: DescribeImageOptions,
): Promise<string | null> {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — cannot describe image');
    return null;
  }

  const model = opts.model || DEFAULT_MODEL;
  const dataUrl = `data:${opts.mimeType};base64,${imageBuffer.toString('base64')}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: dataUrl } }],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText, model },
        'OpenAI image caption failed',
      );
      return null;
    }

    const result = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) {
      logger.warn({ model }, 'OpenAI image caption returned empty content');
      return null;
    }
    logger.info({ chars: content.length, model }, 'Generated image caption');
    return content;
  } catch (err) {
    logger.error({ err, model }, 'OpenAI image caption request failed');
    return null;
  }
}
