import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the .env file reader so tests don't pick up real on-disk credentials.
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

import { describeImage } from './image-caption.js';

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

describe('describeImage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  });

  function mockOk(content: string): void {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response,
    );
  }

  it('returns the russian caption parsed from the chat completion', async () => {
    mockOk('закат над гаванью, силуэты кранов');
    const caption = await describeImage(Buffer.from([0xff, 0xd8, 0xff]), {
      mimeType: 'image/jpeg',
      model: 'gpt-4o-mini',
    });
    expect(caption).toBe('закат над гаванью, силуэты кранов');
  });

  it('sends the image as a base64 data url with the configured model', async () => {
    mockOk('описание');
    await describeImage(Buffer.from('hello'), {
      mimeType: 'image/png',
      model: 'gpt-4o-mini',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit)?.method).toBe('POST');
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');

    const body = JSON.parse((init as RequestInit)?.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/по-русски/);
    expect(body.messages[0].content).toMatch(/полнотекстов/);

    const userContent = body.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    const imagePart = userContent.find(
      (p: { type: string }) => p.type === 'image_url',
    );
    expect(imagePart).toBeDefined();
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
    // hello → aGVsbG8=
    expect(imagePart.image_url.url).toContain('aGVsbG8=');
  });

  it('uses gpt-4o-mini as the default model when none is provided', async () => {
    mockOk('foo');
    await describeImage(Buffer.from('x'), { mimeType: 'image/jpeg' });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit)?.body as string,
    );
    expect(body.model).toBe('gpt-4o-mini');
  });

  it('returns null and does not throw on a non-200 response', async () => {
    fetchSpy.mockResolvedValue(
      new Response('rate limited', { status: 429 }) as unknown as Response,
    );
    const result = await describeImage(Buffer.from('x'), {
      mimeType: 'image/jpeg',
    });
    expect(result).toBeNull();
  });

  it('returns null and does not throw when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const result = await describeImage(Buffer.from('x'), {
      mimeType: 'image/jpeg',
    });
    expect(result).toBeNull();
  });

  it('returns null when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await describeImage(Buffer.from('x'), {
      mimeType: 'image/jpeg',
    });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when the response has no choices', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
      }) as unknown as Response,
    );
    const result = await describeImage(Buffer.from('x'), {
      mimeType: 'image/jpeg',
    });
    expect(result).toBeNull();
  });
});
