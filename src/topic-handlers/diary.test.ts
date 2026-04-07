import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NewMessage, RegisteredGroup } from '../types.js';
import { createDiaryHandler, type DiaryHandlerDeps } from './diary.js';
import type { TopicHandlerContext } from './index.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'main',
    folder: 'main',
    trigger: '@x',
    added_at: '2026-01-01T00:00:00Z',
    isMain: true,
    containerConfig: {
      additionalMounts: [
        { hostPath: '/var/data/notes', containerPath: 'notes' },
      ],
    },
  };
}

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '100',
    chat_jid: 'tg:1',
    sender: '42',
    sender_name: 'Sergei',
    content: 'hello world',
    timestamp: '2026-04-07T14:33:04.000Z',
    ...overrides,
  };
}

describe('diary handler — text path', () => {
  let tmpDir: string;
  let replyMock: ReturnType<typeof vi.fn>;
  let deps: DiaryHandlerDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-text-'));
    replyMock = vi.fn().mockResolvedValue(undefined);
    deps = {
      now: () => new Date('2026-04-07T14:33:04.000Z'),
      timezone: 'UTC',
      resolveDiaryRoot: () => tmpDir,
      transcribeAudio: vi.fn() as any,
      describeImage: vi.fn() as any,
      extractAudioFromVideo: vi.fn() as any,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildContext(
    overrides: Partial<TopicHandlerContext> = {},
  ): TopicHandlerContext {
    return {
      group: makeGroup(),
      chatJid: 'tg:1',
      threadId: '5',
      message: makeMessage(),
      reply: replyMock as any,
      ...overrides,
    };
  }

  it('creates the per-day directory and writes a Note entry', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    const result = await handler.handle(buildContext());

    expect(result).toEqual({ consumed: true });
    const file = path.join(tmpDir, '2026-04-07', '2026-04-07.md');
    expect(fs.existsSync(file)).toBe(true);
    const contents = fs.readFileSync(file, 'utf-8');
    expect(contents).toContain('## 14:33 · Note');
    expect(contents).toContain('hello world');
  });

  it('appends new entries without modifying existing content', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );

    await handler.handle(
      buildContext({ message: makeMessage({ content: 'first', id: '1' }) }),
    );

    // Mutate now() so the second entry has a later timestamp
    deps.now = () => new Date('2026-04-07T15:01:00.000Z');

    await handler.handle(
      buildContext({ message: makeMessage({ content: 'second', id: '2' }) }),
    );

    const file = path.join(tmpDir, '2026-04-07', '2026-04-07.md');
    const contents = fs.readFileSync(file, 'utf-8');

    // Both entries present
    expect(contents).toContain('first');
    expect(contents).toContain('second');

    // First entry's bytes are physically before the second's (append order preserved)
    expect(contents.indexOf('first')).toBeLessThan(contents.indexOf('second'));

    // The second write must NOT have stripped the original entry
    const firstHeaderCount = (contents.match(/## 14:33 · Note/g) || []).length;
    expect(firstHeaderCount).toBe(1);
  });

  it('posts a confirmation reply with the relative file path', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());
    expect(replyMock).toHaveBeenCalledOnce();
    const [text, opts] = replyMock.mock.calls[0];
    expect(text).toContain('2026-04-07/2026-04-07.md');
    expect(text).toContain('11'); // 'hello world' length
    expect(opts).toEqual({ parseMode: 'HTML' });
  });

  it('uses the timezone from deps when computing the local date and time', async () => {
    deps.timezone = 'Europe/Berlin';
    deps.now = () => new Date('2026-04-07T22:33:00.000Z'); // 00:33 next day in Berlin
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const file = path.join(tmpDir, '2026-04-08', '2026-04-08.md');
    expect(fs.existsSync(file)).toBe(true);
    const contents = fs.readFileSync(file, 'utf-8');
    expect(contents).toContain('## 00:33 · Note');
  });
});

describe('diary handler — voice path', () => {
  let tmpDir: string;
  let replyMock: ReturnType<typeof vi.fn>;
  let deps: DiaryHandlerDeps;
  let transcribeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-voice-'));
    replyMock = vi.fn().mockResolvedValue(undefined);
    transcribeMock = vi
      .fn()
      .mockResolvedValue('hello from the test transcript');
    deps = {
      now: () => new Date('2026-04-07T14:33:04.000Z'),
      timezone: 'UTC',
      resolveDiaryRoot: () => tmpDir,
      transcribeAudio: transcribeMock as any,
      describeImage: vi.fn() as any,
      extractAudioFromVideo: vi.fn() as any,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildContext(
    media: Partial<TopicHandlerContext['media']> = {},
  ): TopicHandlerContext {
    return {
      group: makeGroup(),
      chatJid: 'tg:1',
      threadId: '5',
      message: makeMessage({ content: '[Voice]' }),
      reply: replyMock as any,
      media: {
        kind: 'voice',
        buffer: Buffer.from([0x4f, 0x67, 0x67, 0x53]), // 'OggS'
        filename: 'voice.ogg',
        durationSec: 42,
        ...media,
      } as TopicHandlerContext['media'],
    };
  }

  it('archives the audio buffer with a timestamped filename', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const archivedPath = path.join(
      tmpDir,
      '2026-04-07',
      'media',
      '2026-04-07 14-33-04.ogg',
    );
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(fs.readFileSync(archivedPath)).toEqual(
      Buffer.from([0x4f, 0x67, 0x67, 0x53]),
    );
  });

  it('writes a Voice entry with an audio embed and plain-text transcript', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const file = path.join(tmpDir, '2026-04-07', '2026-04-07.md');
    const contents = fs.readFileSync(file, 'utf-8');
    expect(contents).toContain('## 14:33 · Voice (00:42)');
    expect(contents).toContain('![audio](media/2026-04-07%2014-33-04.ogg)');
    expect(contents).toContain('hello from the test transcript');
    // Plain text — not a blockquote line
    expect(contents).not.toContain('> hello from the test transcript');
  });

  it('posts an HTML reply with an expandable transcript blockquote', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    expect(replyMock).toHaveBeenCalledOnce();
    const [text, opts] = replyMock.mock.calls[0];
    expect(opts).toEqual({ parseMode: 'HTML' });
    expect(text).toContain('<blockquote expandable>');
    expect(text).toContain('hello from the test transcript');
    expect(text).toContain('0:42'); // duration in mm:ss with leading zero stripped from minutes
    expect(text).toMatch(/5\s+words/);
  });

  it('html-escapes the transcript before pasting it into the blockquote', async () => {
    transcribeMock.mockResolvedValue('a < b & c > d');
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const text = replyMock.mock.calls[0][0] as string;
    expect(text).toContain('a &lt; b &amp; c &gt; d');
    expect(text).not.toContain('a < b & c > d');
  });

  it('falls back to a placeholder transcript when transcription returns null', async () => {
    transcribeMock.mockResolvedValue(null);
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const file = path.join(tmpDir, '2026-04-07', '2026-04-07.md');
    const contents = fs.readFileSync(file, 'utf-8');
    expect(contents).toContain('_(transcription unavailable)_');
  });

  it('treats audio kind the same as voice', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(
      buildContext({ kind: 'audio', filename: 'song.mp3', durationSec: 7 }),
    );

    const archivedPath = path.join(
      tmpDir,
      '2026-04-07',
      'media',
      '2026-04-07 14-33-04.mp3',
    );
    expect(fs.existsSync(archivedPath)).toBe(true);
    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('## 14:33 · Voice (00:07)');
  });
});

describe('diary handler — photo path', () => {
  let tmpDir: string;
  let replyMock: ReturnType<typeof vi.fn>;
  let deps: DiaryHandlerDeps;
  let describeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-photo-'));
    replyMock = vi.fn().mockResolvedValue(undefined);
    describeMock = vi
      .fn()
      .mockResolvedValue('закат над гаванью, силуэты портовых кранов');
    deps = {
      now: () => new Date('2026-04-07T15:01:22.000Z'),
      timezone: 'UTC',
      resolveDiaryRoot: () => tmpDir,
      transcribeAudio: vi.fn() as any,
      describeImage: describeMock as any,
      extractAudioFromVideo: vi.fn() as any,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildContext(
    media: Partial<TopicHandlerContext['media']> = {},
  ): TopicHandlerContext {
    return {
      group: makeGroup(),
      chatJid: 'tg:1',
      threadId: '5',
      message: makeMessage({ content: '[Photo]' }),
      reply: replyMock as any,
      media: {
        kind: 'photo',
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // jpeg header bytes
        filename: 'photo_100.jpg',
        mimeType: 'image/jpeg',
        ...media,
      } as TopicHandlerContext['media'],
    };
  }

  it('archives the image and writes a Photo entry with a russian alt text', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes', imageCaptionModel: 'gpt-4o-mini' },
      deps,
    );
    await handler.handle(buildContext());

    const archivedPath = path.join(
      tmpDir,
      '2026-04-07',
      'media',
      '2026-04-07 15-01-22.jpg',
    );
    expect(fs.existsSync(archivedPath)).toBe(true);

    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('## 15:01 · Photo');
    expect(contents).toContain(
      '![закат над гаванью, силуэты портовых кранов](media/2026-04-07%2015-01-22.jpg)',
    );
  });

  it('passes the configured image caption model to describeImage', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes', imageCaptionModel: 'gpt-5o-mini-vision' },
      deps,
    );
    await handler.handle(buildContext());

    expect(describeMock).toHaveBeenCalledOnce();
    const opts = describeMock.mock.calls[0][1];
    expect(opts.model).toBe('gpt-5o-mini-vision');
    expect(opts.mimeType).toBe('image/jpeg');
  });

  it('falls back to alt="фото" when describeImage returns null', async () => {
    describeMock.mockResolvedValue(null);
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('![фото](media/2026-04-07%2015-01-22.jpg)');
  });

  it('appends the user caption (if any) on its own line under the image', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext({ caption: 'shot from the harbor' }));

    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('shot from the harbor');
  });

  it('posts an HTML reply showing the caption preview', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    expect(replyMock).toHaveBeenCalledOnce();
    const [text, opts] = replyMock.mock.calls[0];
    expect(opts).toEqual({ parseMode: 'HTML' });
    expect(text).toContain('Photo');
    expect(text).toContain('закат над гаванью');
  });
});

describe('diary handler — document path', () => {
  let tmpDir: string;
  let replyMock: ReturnType<typeof vi.fn>;
  let deps: DiaryHandlerDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-doc-'));
    replyMock = vi.fn().mockResolvedValue(undefined);
    deps = {
      now: () => new Date('2026-04-07T15:14:09.000Z'),
      timezone: 'UTC',
      resolveDiaryRoot: () => tmpDir,
      transcribeAudio: vi.fn() as any,
      describeImage: vi.fn() as any,
      extractAudioFromVideo: vi.fn() as any,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildContext(
    media: Partial<TopicHandlerContext['media']> = {},
  ): TopicHandlerContext {
    return {
      group: makeGroup(),
      chatJid: 'tg:1',
      threadId: '5',
      message: makeMessage({ content: '[Document]' }),
      reply: replyMock as any,
      media: {
        kind: 'document',
        buffer: Buffer.from('%PDF-1.4 fake pdf bytes'),
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        ...media,
      } as TopicHandlerContext['media'],
    };
  }

  it('archives the file under media/ with a timestamped filename keeping the extension', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const archivedPath = path.join(
      tmpDir,
      '2026-04-07',
      'media',
      '2026-04-07 15-14-09.pdf',
    );
    expect(fs.existsSync(archivedPath)).toBe(true);
  });

  it('writes a PDF entry that links to the archived file by its display name', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('## 15:14 · PDF');
    expect(contents).toContain(
      '[receipt.pdf](media/2026-04-07%2015-14-09.pdf)',
    );
  });

  it('includes the user caption when one is provided', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext({ caption: 'shopping list' }));
    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('shopping list');
  });

  it('posts an HTML reply with filename and size', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());
    const [text, opts] = replyMock.mock.calls[0];
    expect(opts).toEqual({ parseMode: 'HTML' });
    expect(text).toContain('receipt.pdf');
    expect(text).toMatch(/KB|bytes/);
  });
});

describe('diary handler — video path', () => {
  let tmpDir: string;
  let replyMock: ReturnType<typeof vi.fn>;
  let deps: DiaryHandlerDeps;
  let extractMock: ReturnType<typeof vi.fn>;
  let transcribeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-video-'));
    replyMock = vi.fn().mockResolvedValue(undefined);
    extractMock = vi.fn().mockResolvedValue(Buffer.from('extracted ogg bytes'));
    transcribeMock = vi.fn().mockResolvedValue('hello from the video');
    deps = {
      now: () => new Date('2026-04-07T16:00:00.000Z'),
      timezone: 'UTC',
      resolveDiaryRoot: () => tmpDir,
      transcribeAudio: transcribeMock as any,
      describeImage: vi.fn() as any,
      extractAudioFromVideo: extractMock as any,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildContext(
    media: Partial<TopicHandlerContext['media']> = {},
  ): TopicHandlerContext {
    return {
      group: makeGroup(),
      chatJid: 'tg:1',
      threadId: '5',
      message: makeMessage({ content: '[Video]' }),
      reply: replyMock as any,
      media: {
        kind: 'video',
        buffer: Buffer.from([0x00, 0x00, 0x00, 0x18]),
        filename: 'video_100.mp4',
        durationSec: 75,
        ...media,
      } as TopicHandlerContext['media'],
    };
  }

  it('archives the video, extracts audio, transcribes it, and writes a Video entry', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const archivedPath = path.join(
      tmpDir,
      '2026-04-07',
      'media',
      '2026-04-07 16-00-00.mp4',
    );
    expect(fs.existsSync(archivedPath)).toBe(true);

    expect(extractMock).toHaveBeenCalledOnce();
    expect(transcribeMock).toHaveBeenCalledOnce();

    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('## 16:00 · Video (01:15)');
    expect(contents).toContain('[video](media/2026-04-07%2016-00-00.mp4)');
    expect(contents).toContain('> hello from the video');
  });

  it('still writes a Video entry (without transcript) if extraction fails', async () => {
    extractMock.mockResolvedValue(null);
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(buildContext());

    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('## 16:00 · Video (01:15)');
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it('handles video_note kind the same as video', async () => {
    const handler = createDiaryHandler(
      makeGroup(),
      { mountName: 'notes' },
      deps,
    );
    await handler.handle(
      buildContext({ kind: 'video_note', filename: 'note.mp4' }),
    );
    const contents = fs.readFileSync(
      path.join(tmpDir, '2026-04-07', '2026-04-07.md'),
      'utf-8',
    );
    expect(contents).toContain('## 16:00 · Video (01:15)');
  });
});
