/**
 * Per-topic message dispatch for forum-style channels (Telegram topics, etc.).
 *
 * A channel that supports threads can call {@link getTopicHandler} for each
 * incoming message and, if a handler is returned, route the message to it
 * instead of (or alongside) the normal agent loop. The handler decides
 * whether the message is fully consumed or should fall through to default
 * processing.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { NewMessage, RegisteredGroup } from '../types.js';

// ---------- Public types ----------

export interface MediaPayload {
  kind: 'voice' | 'audio' | 'video' | 'video_note' | 'photo' | 'document';
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  durationSec?: number;
  caption?: string;
}

export interface TopicHandlerContext {
  group: RegisteredGroup;
  chatJid: string;
  threadId: string;
  threadName?: string;
  message: NewMessage;
  media?: MediaPayload;
  reply: (
    text: string,
    opts?: { parseMode?: 'HTML' | 'Markdown' },
  ) => Promise<void>;
}

export interface TopicHandlerResult {
  consumed: boolean;
}

export interface TopicHandler {
  name: string;
  handle(ctx: TopicHandlerContext): Promise<TopicHandlerResult>;
}

export type TopicHandlerFactory = (
  group: RegisteredGroup,
  config: Record<string, unknown>,
) => TopicHandler;

export interface TopicEntryConfig {
  name?: string;
  handler: string;
  config?: Record<string, unknown>;
}

export interface TopicHandlersConfig {
  topics: Record<string, TopicEntryConfig>;
}

// ---------- Factory registry (handlers register themselves on import) ----------

const factories = new Map<string, TopicHandlerFactory>();

export function registerTopicHandler(
  name: string,
  factory: TopicHandlerFactory,
): void {
  factories.set(name, factory);
}

// ---------- Config loading ----------

/**
 * Load and parse a topic-handlers.json file. Returns null on any failure
 * (file missing, malformed JSON). Logs a warning when the file exists but
 * cannot be parsed — fail-open so a typo never bricks the message loop.
 */
export function loadTopicHandlersConfig(
  filePath: string,
): TopicHandlersConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TopicHandlersConfig;
    if (!parsed || typeof parsed !== 'object' || !parsed.topics) {
      logger.warn(
        { filePath },
        'topic-handlers config has no "topics" object — ignoring',
      );
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn(
      { err, filePath },
      'topic-handlers config is malformed — ignoring',
    );
    return null;
  }
}

// ---------- Per-group cache with mtime invalidation ----------

interface CacheEntry {
  mtimeMs: number;
  config: TopicHandlersConfig | null;
  /** Constructed handlers by topic id, populated lazily on first access. */
  handlers: Map<string, TopicHandler | null>;
}

const cache = new Map<string, CacheEntry>(); // key: groupFolder

/** @internal — only for tests */
export function _resetTopicHandlerRegistryForTests(): void {
  factories.clear();
  cache.clear();
}

interface GetTopicHandlerOpts {
  /** Override the directory that contains group folders. Test-only. */
  configRoot?: string;
}

function configFilePathFor(
  group: RegisteredGroup,
  configRoot?: string,
): string {
  const root = configRoot ?? GROUPS_DIR;
  return path.join(root, group.folder, 'topic-handlers.json');
}

/**
 * Resolve the topic handler responsible for a given (group, threadId) pair,
 * or null if no handler is configured. Returns null when threadId is undefined,
 * matching the General-topic / non-forum-chat case.
 *
 * The handler instance is cached per (group, topic) and re-built when the
 * underlying config file's mtime changes — so editing the JSON and saving
 * is enough; no service restart needed.
 */
export function getTopicHandler(
  group: RegisteredGroup,
  threadId: string | undefined,
  opts: GetTopicHandlerOpts = {},
): TopicHandler | null {
  if (!threadId) return null;

  const filePath = configFilePathFor(group, opts.configRoot);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // No config file → no handlers for this group.
    cache.delete(group.folder);
    return null;
  }

  let entry = cache.get(group.folder);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    entry = {
      mtimeMs,
      config: loadTopicHandlersConfig(filePath),
      handlers: new Map(),
    };
    cache.set(group.folder, entry);
  }

  if (entry.handlers.has(threadId)) {
    return entry.handlers.get(threadId) ?? null;
  }

  const topicCfg = entry.config?.topics?.[threadId];
  if (!topicCfg) {
    entry.handlers.set(threadId, null);
    return null;
  }

  const factory = factories.get(topicCfg.handler);
  if (!factory) {
    logger.warn(
      { groupFolder: group.folder, threadId, handler: topicCfg.handler },
      'topic-handlers config references unknown handler — ignoring',
    );
    entry.handlers.set(threadId, null);
    return null;
  }

  const handler = factory(group, topicCfg.config ?? {});
  entry.handlers.set(threadId, handler);
  return handler;
}
