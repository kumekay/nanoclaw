/**
 * Diary topic handler — pure ingestion of forum-topic messages into a
 * date-bucketed markdown journal under a host directory the agent also
 * has mounted (typically the main group's "notes" mount).
 *
 * No agent invocation. Voice/audio uses Whisper, photos use an OpenAI
 * vision chat completion for Russian alt-text. Strict append-only.
 */
import fs from 'fs';
import path from 'path';

import { TIMEZONE } from '../config.js';
import { resolveAdditionalMountHostPath } from '../group-folder.js';
import {
  describeImage as defaultDescribeImage,
  type DescribeImageOptions,
} from '../image-caption.js';
import { logger } from '../logger.js';
import {
  extractAudioFromVideo as defaultExtractAudioFromVideo,
  transcribeAudio as defaultTranscribeAudio,
} from '../transcription.js';
import type { RegisteredGroup } from '../types.js';
import {
  formatDocumentEntry,
  formatNoteEntry,
  formatPhotoEntry,
  formatVideoEntry,
  formatVoiceEntry,
} from './diary-format.js';
import {
  registerTopicHandler,
  type MediaPayload,
  type TopicHandler,
  type TopicHandlerContext,
  type TopicHandlerResult,
} from './index.js';

// ---------- Config / dependencies ----------

export interface DiaryConfig {
  /** Name of the additional mount that holds the diary root. Default: "notes". */
  mountName?: string;
  /** Subdirectory under the mount where diary entries live. Default: "dairy". */
  subdir?: string;
  /** OpenAI vision model used for image captions. Default: "gpt-4o-mini". */
  imageCaptionModel?: string;
}

export interface DiaryHandlerDeps {
  now: () => Date;
  timezone: string;
  /** Returns the absolute host path of the diary root directory. */
  resolveDiaryRoot: () => string;
  transcribeAudio: (buf: Buffer, filename: string) => Promise<string | null>;
  describeImage: (
    buf: Buffer,
    opts: DescribeImageOptions,
  ) => Promise<string | null>;
  extractAudioFromVideo: (
    buf: Buffer,
    inputExt: string,
  ) => Promise<Buffer | null>;
}

// ---------- Local-time helpers ----------

/**
 * Format a Date in the requested IANA timezone using Intl.DateTimeFormat.
 * Returns parts for year/month/day/hour/minute/second so we can build
 * filenames and entry headers without timezone math.
 */
function getLocalParts(
  date: Date,
  timezone: string,
): {
  yyyy: string;
  mm: string;
  dd: string;
  hh: string;
  mi: string;
  ss: string;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    yyyy: parts.year,
    mm: parts.month,
    dd: parts.day,
    hh: parts.hour,
    mi: parts.minute,
    ss: parts.second,
  };
}

function localDate(parts: ReturnType<typeof getLocalParts>): string {
  return `${parts.yyyy}-${parts.mm}-${parts.dd}`;
}

function localTime(parts: ReturnType<typeof getLocalParts>): string {
  return `${parts.hh}:${parts.mi}`;
}

function localFullStamp(parts: ReturnType<typeof getLocalParts>): string {
  // "YYYY-MM-DD HH-MM-SS" — matches the user's existing notes convention.
  // Hyphens (not colons) between time components so the filename round-trips
  // through markdown viewers that mishandle %3A. The literal space is fine:
  // viewers decode %20 back to a space without trouble.
  return `${parts.yyyy}-${parts.mm}-${parts.dd} ${parts.hh}-${parts.mi}-${parts.ss}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Filesystem helpers ----------

function ensureDailyDir(
  diaryRoot: string,
  date: string,
): {
  dailyDir: string;
  mediaDir: string;
  markdownPath: string;
} {
  const dailyDir = path.join(diaryRoot, date);
  const mediaDir = path.join(dailyDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  return {
    dailyDir,
    mediaDir,
    markdownPath: path.join(dailyDir, `${date}.md`),
  };
}

/**
 * Append an entry to the daily file. Always uses fs.appendFileSync so we
 * never read+rewrite, satisfying the strict append-only contract.
 * Inserts a leading blank line for any append after the first byte.
 */
function appendEntry(markdownPath: string, body: string): void {
  const exists = fs.existsSync(markdownPath);
  const prefix = exists && fs.statSync(markdownPath).size > 0 ? '\n' : '';
  fs.appendFileSync(markdownPath, prefix + body);
}

// ---------- Handler implementation ----------

class DiaryHandler implements TopicHandler {
  readonly name = 'diary';

  constructor(
    private readonly group: RegisteredGroup,
    private readonly config: DiaryConfig,
    private readonly deps: DiaryHandlerDeps,
  ) {}

  async handle(ctx: TopicHandlerContext): Promise<TopicHandlerResult> {
    try {
      const media = ctx.media;
      if (!media) {
        await this.handleText(ctx);
      } else if (media.kind === 'voice' || media.kind === 'audio') {
        await this.handleVoice(ctx, media);
      } else if (media.kind === 'photo') {
        await this.handlePhoto(ctx, media);
      } else if (media.kind === 'video' || media.kind === 'video_note') {
        await this.handleVideo(ctx, media);
      } else if (media.kind === 'document') {
        await this.handleDocument(ctx, media);
      } else {
        await this.handleText(ctx);
      }
    } catch (err) {
      logger.error(
        { err, threadId: ctx.threadId, group: this.group.folder },
        'diary handler failed',
      );
      // Even on failure we consume the message — we don't want the agent
      // to also pick it up. The user can resend if needed.
    }
    return { consumed: true };
  }

  // ---- text branch ----

  private async handleText(ctx: TopicHandlerContext): Promise<void> {
    const parts = getLocalParts(this.deps.now(), this.deps.timezone);
    const date = localDate(parts);
    const time = localTime(parts);

    const root = this.deps.resolveDiaryRoot();
    const { markdownPath } = ensureDailyDir(root, date);

    const body = formatNoteEntry({ time, body: ctx.message.content });
    appendEntry(markdownPath, body);

    const relPath = `${date}/${date}.md`;
    const charCount = ctx.message.content.length;
    const reply =
      `\u2713 Added to <code>${escapeHtml(relPath)}</code>\n` +
      `${charCount} chars`;
    await ctx.reply(reply, { parseMode: 'HTML' });
  }

  // ---- voice / audio branch ----

  private async handleVoice(
    ctx: TopicHandlerContext,
    media: MediaPayload,
  ): Promise<void> {
    const parts = getLocalParts(this.deps.now(), this.deps.timezone);
    const date = localDate(parts);
    const time = localTime(parts);
    const stamp = localFullStamp(parts);

    const root = this.deps.resolveDiaryRoot();
    const { mediaDir, markdownPath } = ensureDailyDir(root, date);

    // Archive the original audio with a timestamped filename. Extension comes
    // from the source filename so .ogg/.mp3/.m4a all survive correctly.
    const ext = path.extname(media.filename) || '.ogg';
    const archiveName = `${stamp}${ext}`;
    const archivePath = path.join(mediaDir, archiveName);
    fs.writeFileSync(archivePath, media.buffer);

    // Transcribe via Whisper. Returns null on failure — we still write an
    // entry with a placeholder so the user has an audit trail.
    const transcript =
      (await this.deps.transcribeAudio(media.buffer, media.filename)) ?? '';

    const durationSec = media.durationSec ?? 0;
    const entry = formatVoiceEntry({
      time,
      durationSec,
      transcript,
      mediaRelPath: `media/${archiveName}`,
    });
    appendEntry(markdownPath, entry);

    const wordCount = transcript.trim()
      ? transcript.trim().split(/\s+/).length
      : 0;
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;
    const durLabel = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    const relPath = `${date}/${date}.md`;

    const blockquoteBody = transcript.trim()
      ? `<blockquote expandable>${escapeHtml(transcript)}</blockquote>`
      : '';
    const reply =
      `\u2713 Added to <code>${escapeHtml(relPath)}</code>\n` +
      `${wordCount} words · ${durLabel} audio\n` +
      blockquoteBody;
    await ctx.reply(reply, { parseMode: 'HTML' });
  }

  // ---- photo branch ----

  private async handlePhoto(
    ctx: TopicHandlerContext,
    media: MediaPayload,
  ): Promise<void> {
    const parts = getLocalParts(this.deps.now(), this.deps.timezone);
    const date = localDate(parts);
    const time = localTime(parts);
    const stamp = localFullStamp(parts);

    const root = this.deps.resolveDiaryRoot();
    const { mediaDir, markdownPath } = ensureDailyDir(root, date);

    const ext = path.extname(media.filename) || '.jpg';
    const archiveName = `${stamp}${ext}`;
    const archivePath = path.join(mediaDir, archiveName);
    fs.writeFileSync(archivePath, media.buffer);

    // Generate Russian alt-text via OpenAI vision. Synchronous so the
    // diary entry is fully formed before we write it (strict append-only).
    const caption = await this.deps.describeImage(media.buffer, {
      mimeType: media.mimeType ?? 'image/jpeg',
      model: this.config.imageCaptionModel,
    });
    const altText = caption?.trim() || 'фото';

    const photoEntry = formatPhotoEntry({
      time,
      mediaRelPath: `media/${archiveName}`,
      altText,
    });
    const userCaption = media.caption?.trim();
    const fullEntry = userCaption
      ? `${photoEntry}${userCaption}\n`
      : photoEntry;
    appendEntry(markdownPath, fullEntry);

    const relPath = `${date}/${date}.md`;
    const sizeKb = (media.buffer.length / 1024).toFixed(1);
    const reply =
      `\u2713 Added Photo to <code>${escapeHtml(relPath)}</code>\n` +
      `${sizeKb} KB · ${escapeHtml(altText)}`;
    await ctx.reply(reply, { parseMode: 'HTML' });
  }

  // ---- video / video_note branch ----

  private async handleVideo(
    ctx: TopicHandlerContext,
    media: MediaPayload,
  ): Promise<void> {
    const parts = getLocalParts(this.deps.now(), this.deps.timezone);
    const date = localDate(parts);
    const time = localTime(parts);
    const stamp = localFullStamp(parts);

    const root = this.deps.resolveDiaryRoot();
    const { mediaDir, markdownPath } = ensureDailyDir(root, date);

    const ext = path.extname(media.filename) || '.mp4';
    const archiveName = `${stamp}${ext}`;
    fs.writeFileSync(path.join(mediaDir, archiveName), media.buffer);

    // Best-effort transcript: extract audio with ffmpeg, then run Whisper.
    // If extraction fails we still write the entry — the video itself is the artifact.
    let transcript = '';
    const audioBuffer = await this.deps.extractAudioFromVideo(
      media.buffer,
      ext,
    );
    if (audioBuffer) {
      transcript =
        (await this.deps.transcribeAudio(audioBuffer, 'audio.ogg')) ?? '';
    }

    const durationSec = media.durationSec ?? 0;
    const entry = formatVideoEntry({
      time,
      durationSec,
      mediaRelPath: `media/${archiveName}`,
      transcript,
    });
    appendEntry(markdownPath, entry);

    const relPath = `${date}/${date}.md`;
    const sizeKb = (media.buffer.length / 1024).toFixed(1);
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;
    const durLabel = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    const blockquoteBody = transcript.trim()
      ? `\n<blockquote expandable>${escapeHtml(transcript)}</blockquote>`
      : '';
    const reply =
      `\u2713 Added Video to <code>${escapeHtml(relPath)}</code>\n` +
      `${sizeKb} KB · ${durLabel}` +
      blockquoteBody;
    await ctx.reply(reply, { parseMode: 'HTML' });
  }

  // ---- document branch ----

  private async handleDocument(
    ctx: TopicHandlerContext,
    media: MediaPayload,
  ): Promise<void> {
    const parts = getLocalParts(this.deps.now(), this.deps.timezone);
    const date = localDate(parts);
    const time = localTime(parts);
    const stamp = localFullStamp(parts);

    const root = this.deps.resolveDiaryRoot();
    const { mediaDir, markdownPath } = ensureDailyDir(root, date);

    const ext = path.extname(media.filename);
    const archiveName = `${stamp}${ext}`;
    fs.writeFileSync(path.join(mediaDir, archiveName), media.buffer);

    const entry = formatDocumentEntry({
      time,
      mediaRelPath: `media/${archiveName}`,
      displayName: media.filename,
      caption: media.caption ?? '',
    });
    appendEntry(markdownPath, entry);

    const relPath = `${date}/${date}.md`;
    const sizeKb = (media.buffer.length / 1024).toFixed(1);
    const reply =
      `\u2713 Added <code>${escapeHtml(media.filename)}</code> to <code>${escapeHtml(relPath)}</code>\n` +
      `${sizeKb} KB`;
    await ctx.reply(reply, { parseMode: 'HTML' });
  }
}

/**
 * Test-friendly factory: lets tests inject deps. Production callers should
 * use the registered factory wired up at the bottom of this file.
 */
export function createDiaryHandler(
  group: RegisteredGroup,
  config: DiaryConfig,
  deps: DiaryHandlerDeps,
): TopicHandler {
  return new DiaryHandler(group, config, deps);
}

function defaultDeps(
  group: RegisteredGroup,
  config: DiaryConfig,
): DiaryHandlerDeps {
  const mountName = config.mountName ?? 'notes';
  const subdir = config.subdir ?? 'dairy';
  return {
    now: () => new Date(),
    timezone: TIMEZONE,
    resolveDiaryRoot: () =>
      path.join(resolveAdditionalMountHostPath(group, mountName), subdir),
    transcribeAudio: defaultTranscribeAudio,
    describeImage: defaultDescribeImage,
    extractAudioFromVideo: defaultExtractAudioFromVideo,
  };
}

// ---------- Self-registration ----------

registerTopicHandler('diary', (group, rawConfig) => {
  const cfg = (rawConfig ?? {}) as DiaryConfig;
  return new DiaryHandler(group, cfg, defaultDeps(group, cfg));
});
