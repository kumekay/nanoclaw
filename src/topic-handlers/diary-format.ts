/**
 * Pure formatters for diary markdown entries.
 *
 * No filesystem IO, no clocks, no globals — every input is explicit so the
 * functions are trivially testable. The diary handler in `diary.ts` calls
 * these to build the body it then appends to the daily markdown file.
 */

export interface VoiceEntryInput {
  time: string; // "HH:MM"
  durationSec: number;
  transcript: string;
  mediaRelPath: string; // path relative to the daily directory, e.g. "media/foo.ogg"
}

export interface NoteEntryInput {
  time: string;
  body: string;
}

export interface PhotoEntryInput {
  time: string;
  mediaRelPath: string; // path relative to the daily directory, e.g. "media/foo.jpg"
  altText: string;
}

export interface DocumentEntryInput {
  time: string;
  mediaRelPath: string;
  displayName: string;
  caption: string;
}

export interface VideoEntryInput {
  time: string;
  durationSec: number;
  mediaRelPath: string;
  transcript: string;
}

/**
 * Encode a relative media path so it survives as a markdown link target.
 * Spaces, colons, and other reserved chars get percent-encoded; the slash
 * separator is preserved.
 */
export function encodeMediaHref(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function formatDuration(durationSec: number): string {
  const total = Math.max(0, Math.floor(durationSec));
  const mm = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function escapeAlt(text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function extensionLabel(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return 'File';
  return filename.slice(dot + 1).toUpperCase();
}

export function formatVoiceEntry(input: VoiceEntryInput): string {
  const header = `## ${input.time} · Voice (${formatDuration(input.durationSec)})`;
  const href = encodeMediaHref(input.mediaRelPath);
  const audio = `![audio](${href})`;
  const body = input.transcript.trim()
    ? input.transcript
    : '_(transcription unavailable)_';
  return `${header}\n${audio}\n${body}\n`;
}

export function formatNoteEntry(input: NoteEntryInput): string {
  return `## ${input.time} · Note\n${input.body}\n`;
}

export function formatPhotoEntry(input: PhotoEntryInput): string {
  const href = encodeMediaHref(input.mediaRelPath);
  const alt = escapeAlt(input.altText);
  return `## ${input.time} · Photo\n![${alt}](${href})\n`;
}

export function formatDocumentEntry(input: DocumentEntryInput): string {
  const href = encodeMediaHref(input.mediaRelPath);
  const ext = extensionLabel(input.displayName);
  const captionLine = input.caption ? `${input.caption}\n` : '';
  return `## ${input.time} · ${ext}\n[${input.displayName}](${href})\n${captionLine}`;
}

export function formatVideoEntry(input: VideoEntryInput): string {
  const header = `## ${input.time} · Video (${formatDuration(input.durationSec)})`;
  const href = encodeMediaHref(input.mediaRelPath);
  const transcript = input.transcript.trim()
    ? `${blockquote(input.transcript)}\n`
    : '';
  return `${header}\n[video](${href})\n${transcript}`;
}
