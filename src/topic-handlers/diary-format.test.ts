import { describe, expect, it } from 'vitest';

import {
  encodeMediaHref,
  formatDocumentEntry,
  formatNoteEntry,
  formatPhotoEntry,
  formatVideoEntry,
  formatVoiceEntry,
} from './diary-format.js';

describe('diary-format', () => {
  describe('encodeMediaHref', () => {
    it('encodes spaces and colons in filenames so markdown links resolve', () => {
      expect(encodeMediaHref('media/2026-04-07 14:33:04.ogg')).toBe(
        'media/2026-04-07%2014%3A33%3A04.ogg',
      );
    });

    it('does not double-encode percent signs already present', () => {
      // Important: we always start from raw filenames, never re-encoded ones.
      expect(encodeMediaHref('media/file with space.jpg')).toBe(
        'media/file%20with%20space.jpg',
      );
    });
  });

  describe('formatVoiceEntry', () => {
    it('renders header with mm:ss duration, audio embed, and plain transcript', () => {
      const entry = formatVoiceEntry({
        time: '14:33',
        durationSec: 42,
        transcript: 'first line\nsecond line',
        mediaRelPath: 'media/2026-04-07 14-33-04.ogg',
      });
      expect(entry).toBe(
        '## 14:33 · Voice (00:42)\n![audio](media/2026-04-07%2014-33-04.ogg)\nfirst line\nsecond line\n',
      );
    });

    it('handles transcripts longer than a minute', () => {
      const entry = formatVoiceEntry({
        time: '09:00',
        durationSec: 125,
        transcript: 'hello',
        mediaRelPath: 'media/x.ogg',
      });
      expect(entry.startsWith('## 09:00 · Voice (02:05)\n')).toBe(true);
    });

    it('falls back to a placeholder when transcript is empty', () => {
      const entry = formatVoiceEntry({
        time: '09:00',
        durationSec: 5,
        transcript: '',
        mediaRelPath: 'media/x.ogg',
      });
      expect(entry).toContain('_(transcription unavailable)_');
      expect(entry).not.toContain('> ');
    });
  });

  describe('formatNoteEntry', () => {
    it('renders a Note header followed by the body', () => {
      const entry = formatNoteEntry({
        time: '15:20',
        body: 'just a thought I had on the bus',
      });
      expect(entry).toBe('## 15:20 · Note\njust a thought I had on the bus\n');
    });

    it('preserves multi-line bodies verbatim', () => {
      const entry = formatNoteEntry({
        time: '15:20',
        body: 'line one\nline two',
      });
      expect(entry).toBe('## 15:20 · Note\nline one\nline two\n');
    });
  });

  describe('formatPhotoEntry', () => {
    it('renders a Photo header with the russian alt text and url-encoded link', () => {
      const entry = formatPhotoEntry({
        time: '15:01',
        mediaRelPath: 'media/2026-04-07 15:01:22.jpg',
        altText: 'закат над гаванью, силуэты кранов',
      });
      expect(entry).toBe(
        '## 15:01 · Photo\n![закат над гаванью, силуэты кранов](media/2026-04-07%2015%3A01%3A22.jpg)\n',
      );
    });

    it('escapes brackets in alt text so markdown stays valid', () => {
      const entry = formatPhotoEntry({
        time: '15:01',
        mediaRelPath: 'media/x.jpg',
        altText: 'a [bracketed] thing',
      });
      expect(entry).toContain('![a \\[bracketed\\] thing](media/x.jpg)');
    });
  });

  describe('formatDocumentEntry', () => {
    it('renders a header with the extension and a markdown link to the file', () => {
      const entry = formatDocumentEntry({
        time: '15:14',
        mediaRelPath: 'media/2026-04-07 15:14:09.pdf',
        displayName: 'receipt.pdf',
        caption: '',
      });
      expect(entry).toBe(
        '## 15:14 · PDF\n[receipt.pdf](media/2026-04-07%2015%3A14%3A09.pdf)\n',
      );
    });

    it('appends an optional caption on its own line', () => {
      const entry = formatDocumentEntry({
        time: '15:14',
        mediaRelPath: 'media/notes.txt',
        displayName: 'notes.txt',
        caption: 'shopping list',
      });
      expect(entry).toBe(
        '## 15:14 · TXT\n[notes.txt](media/notes.txt)\nshopping list\n',
      );
    });

    it('falls back to "File" header when there is no extension', () => {
      const entry = formatDocumentEntry({
        time: '15:14',
        mediaRelPath: 'media/binary',
        displayName: 'binary',
        caption: '',
      });
      expect(entry.startsWith('## 15:14 · File\n')).toBe(true);
    });
  });

  describe('formatVideoEntry', () => {
    it('renders a Video header with link and transcript blockquote', () => {
      const entry = formatVideoEntry({
        time: '16:00',
        durationSec: 75,
        mediaRelPath: 'media/2026-04-07 16:00:00.mp4',
        transcript: 'hello world',
      });
      expect(entry).toBe(
        '## 16:00 · Video (01:15)\n[video](media/2026-04-07%2016%3A00%3A00.mp4)\n> hello world\n',
      );
    });

    it('omits the transcript section when transcript is empty', () => {
      const entry = formatVideoEntry({
        time: '16:00',
        durationSec: 10,
        mediaRelPath: 'media/x.mp4',
        transcript: '',
      });
      expect(entry).toBe('## 16:00 · Video (00:10)\n[video](media/x.mp4)\n');
    });
  });
});
