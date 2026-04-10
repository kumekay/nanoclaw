import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { getTopicHandler, type MediaPayload } from '../topic-handlers/index.js';
import {
  downloadTelegramFile,
  extractAudioFromVideo,
  transcribeAudio,
} from '../transcription.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with the requested Telegram parse mode, falling back to
 * plain text on parse errors. Claude's output naturally matches Telegram's
 * Markdown v1 format (*bold*, _italic_, `code`, ```code blocks```,
 * [links](url)); topic handlers that need richer formatting (e.g. expandable
 * blockquotes for diary entries) can request HTML.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    message_thread_id?: number;
    parseMode?: 'HTML' | 'Markdown';
  } = {},
): Promise<void> {
  const parseMode = options.parseMode ?? 'Markdown';
  const apiOptions: {
    message_thread_id?: number;
    parse_mode: 'HTML' | 'Markdown';
  } = {
    parse_mode: parseMode,
  };
  if (options.message_thread_id !== undefined) {
    apiOptions.message_thread_id = options.message_thread_id;
  }
  try {
    await api.sendMessage(chatId, text, apiOptions);
  } catch (err) {
    // Fallback: send as plain text if parse_mode parsing fails
    logger.debug(
      { err, parseMode },
      'Telegram parse_mode send failed, falling back to plain text',
    );
    const plainOptions: { message_thread_id?: number } = {};
    if (options.message_thread_id !== undefined) {
      plainOptions.message_thread_id = options.message_thread_id;
    }
    await api.sendMessage(chatId, text, plainOptions);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to get the current forum topic id (for topic-handler config).
    // Reply when invoked outside of a topic so the user knows they're in General.
    this.bot.command('topicid', (ctx) => {
      const tid = (ctx.message as any)?.message_thread_id;
      if (tid !== undefined) {
        ctx.reply(`Topic ID: \`${tid}\``, { parse_mode: 'Markdown' });
      } else {
        ctx.reply('General topic (no thread id)', { parse_mode: 'Markdown' });
      }
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'topicid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Topic handler dispatch — runs before metadata/onMessage so the
      // diary topic (and any future per-topic handler) can fully short-circuit
      // the main agent loop. Only fires for registered groups inside a forum
      // topic; the General topic (threadId === undefined) keeps today's flow.
      const groupForDispatch = this.opts.registeredGroups()[chatJid];
      if (groupForDispatch && threadId !== undefined) {
        const consumed = await this.tryTopicHandler(
          ctx,
          groupForDispatch,
          threadId,
          content,
        );
        if (consumed) return;
      }

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, threadId },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      // Download once and reuse for both topic-handler dispatch and the
      // existing media-archive fallback.
      let buffer: Buffer | null = null;
      let filename = '';
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await this.bot!.api.getFile(largest.file_id);
        if (!file.file_path) throw new Error('No file_path in response');
        buffer = await downloadTelegramFile(this.botToken, file.file_path);
        if (!buffer) throw new Error('Failed to download photo');
        const ext = path.extname(file.file_path) || '.jpg';
        filename = `photo_${ctx.message.message_id}${ext}`;
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to download Telegram photo');
      }

      // Topic handler dispatch (only if download succeeded — handlers need the buffer)
      if (buffer) {
        const consumed = await this.tryTopicHandler(
          ctx,
          group,
          ctx.message.message_thread_id,
          undefined,
          {
            kind: 'photo',
            buffer,
            filename,
            mimeType: 'image/jpeg',
            caption: ctx.message.caption,
          },
        );
        if (consumed) return;
      }

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content: string;
      if (buffer) {
        const groupDir = resolveGroupFolderPath(group.folder);
        const mediaDir = path.join(groupDir, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, filename), buffer);

        // Container sees this at /workspace/group/media/
        content = `[Photo: /workspace/group/media/${filename}]${caption}`;
        logger.info(
          { chatJid, filename, size: buffer.length },
          'Saved photo from Telegram',
        );
      } else {
        content = `[Photo]${caption}`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Voice and audio: download, optionally dispatch to a topic handler,
    // otherwise transcribe and store via the regular onMessage flow.
    const transcribeAndStore = async (
      ctx: any,
      fileId: string,
      label: string,
      filename: string,
      mediaKind: 'voice' | 'audio',
      durationSec: number,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Download once and reuse for both dispatch and fallback paths.
      let buffer: Buffer | null = null;
      try {
        const file = await this.bot!.api.getFile(fileId);
        if (!file.file_path) throw new Error('No file_path in response');
        buffer = await downloadTelegramFile(this.botToken, file.file_path);
      } catch (err) {
        logger.error({ err, chatJid, label }, `${label} download failed`);
      }

      // Topic handler dispatch — diary etc. do their own transcription.
      if (buffer) {
        const consumed = await this.tryTopicHandler(
          ctx,
          group,
          ctx.message.message_thread_id,
          undefined,
          {
            kind: mediaKind,
            buffer,
            filename,
            durationSec,
            caption: ctx.message.caption,
          },
        );
        if (consumed) return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content: string;
      try {
        if (!buffer) throw new Error('Failed to download file');
        const transcript = await transcribeAudio(buffer, filename);
        content = transcript
          ? `[${label}: ${transcript}]${caption}`
          : `[${label} - transcription unavailable]${caption}`;
      } catch (err) {
        logger.error({ err, chatJid, label }, 'Transcription pipeline failed');
        content = `[${label} - transcription failed]${caption}`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    // Video/video_note: download, optionally dispatch to a topic handler,
    // otherwise extract audio with ffmpeg and transcribe.
    const transcribeVideoAndStore = async (
      ctx: any,
      fileId: string,
      label: string,
      mediaKind: 'video' | 'video_note',
      durationSec: number,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Download once
      let videoBuffer: Buffer | null = null;
      try {
        const file = await this.bot!.api.getFile(fileId);
        if (!file.file_path) throw new Error('No file_path in response');
        videoBuffer = await downloadTelegramFile(this.botToken, file.file_path);
      } catch (err) {
        logger.error({ err, chatJid, label }, `${label} download failed`);
      }

      // Topic handler dispatch
      if (videoBuffer) {
        const consumed = await this.tryTopicHandler(
          ctx,
          group,
          ctx.message.message_thread_id,
          undefined,
          {
            kind: mediaKind,
            buffer: videoBuffer,
            filename: `video_${ctx.message.message_id}.mp4`,
            durationSec,
            caption: ctx.message.caption,
          },
        );
        if (consumed) return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content: string;
      try {
        if (!videoBuffer) throw new Error('Failed to download file');
        const audioBuffer = await extractAudioFromVideo(videoBuffer, '.mp4');
        if (!audioBuffer) throw new Error('Failed to extract audio from video');
        const transcript = await transcribeAudio(audioBuffer, 'audio.ogg');
        content = transcript
          ? `[${label}: ${transcript}]${caption}`
          : `[${label} - transcription unavailable]${caption}`;
      } catch (err) {
        logger.error({ err, chatJid, label }, 'Video transcription failed');
        content = `[${label} - transcription failed]${caption}`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:voice', (ctx) =>
      transcribeAndStore(
        ctx,
        ctx.message.voice.file_id,
        'Voice',
        'voice.ogg',
        'voice',
        ctx.message.voice.duration ?? 0,
      ),
    );
    this.bot.on('message:audio', (ctx) =>
      transcribeAndStore(
        ctx,
        ctx.message.audio.file_id,
        'Audio',
        ctx.message.audio.file_name || 'audio.mp3',
        'audio',
        ctx.message.audio.duration ?? 0,
      ),
    );
    this.bot.on('message:video', (ctx) =>
      transcribeVideoAndStore(
        ctx,
        ctx.message.video.file_id,
        'Video',
        'video',
        ctx.message.video.duration ?? 0,
      ),
    );
    this.bot.on('message:video_note', (ctx) =>
      transcribeVideoAndStore(
        ctx,
        ctx.message.video_note.file_id,
        'Video note',
        'video_note',
        ctx.message.video_note.duration ?? 0,
      ),
    );
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      const fileId = ctx.message.document?.file_id;
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Download for topic dispatch path. Documents have no native transcript
      // pipeline, so the buffer is only needed when a topic handler will use it.
      let buffer: Buffer | null = null;
      if (fileId) {
        try {
          const file = await this.bot!.api.getFile(fileId);
          if (file.file_path) {
            buffer = await downloadTelegramFile(this.botToken, file.file_path);
          }
        } catch (err) {
          logger.error({ err, chatJid }, 'Document download failed');
        }
      }

      if (buffer) {
        const consumed = await this.tryTopicHandler(
          ctx,
          group,
          ctx.message.message_thread_id,
          undefined,
          {
            kind: 'document',
            buffer,
            filename: name,
            mimeType: ctx.message.document?.mime_type,
            caption: ctx.message.caption,
          },
        );
        if (consumed) return;
      }

      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  /**
   * Resolve the topic handler for a (group, threadId) pair and run it.
   * Returns true if the handler fully consumed the message; false on any
   * miss (no thread id, no handler, handler returned consumed=false, or
   * handler threw — all cases fall through to the default onMessage flow).
   *
   * The reply callback wraps {@link sendTelegramMessage} so handlers can
   * post confirmations back into the originating topic with their preferred
   * parse mode (HTML for Telegram-native blockquote formatting, Markdown
   * for Claude-style replies).
   */
  private async tryTopicHandler(
    ctx: any,
    group: RegisteredGroup,
    threadId: number | undefined,
    textContent: string | undefined,
    media?: MediaPayload,
  ): Promise<boolean> {
    if (threadId === undefined) return false;
    const handler = getTopicHandler(group, threadId.toString());
    if (!handler) return false;

    const chatJid = `tg:${ctx.chat.id}`;
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id?.toString() ||
      'Unknown';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const content = textContent ?? ctx.message.caption ?? '';

    const threadIdStr = threadId.toString();
    await this.setTyping(chatJid, true, threadIdStr);
    try {
      const result = await handler.handle({
        group,
        chatJid,
        threadId: threadIdStr,
        message: {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          thread_id: threadIdStr,
        },
        media,
        reply: async (
          text: string,
          opts?: { parseMode?: 'HTML' | 'Markdown' },
        ) => {
          if (!this.bot) return;
          await sendTelegramMessage(
            this.bot.api,
            ctx.chat.id.toString(),
            text,
            {
              message_thread_id: threadId,
              parseMode: opts?.parseMode,
            },
          );
        },
      });
      return result.consumed;
    } catch (err) {
      logger.error(
        { err, chatJid, threadId, handler: handler.name },
        'topic handler threw — falling back to default flow',
      );
      return false;
    } finally {
      await this.setTyping(chatJid, false, threadIdStr);
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  // Telegram typing indicators expire after ~5s, so we resend every 4s
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async setTyping(
    jid: string,
    isTyping: boolean,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) return;

    const key = `${jid}:${threadId || ''}`;
    const existing = this.typingIntervals.get(key);
    if (!isTyping) {
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(key);
      }
      return;
    }

    // Already typing for this jid+thread
    if (existing) return;

    const numericId = jid.replace(/^tg:/, '');
    const opts = threadId ? { message_thread_id: parseInt(threadId, 10) } : {};
    const sendTyping = () => {
      this.bot?.api
        .sendChatAction(numericId, 'typing', opts)
        .catch((err) =>
          logger.debug(
            { jid, threadId, err },
            'Failed to send Telegram typing indicator',
          ),
        );
    };

    sendTyping();
    this.typingIntervals.set(key, setInterval(sendTyping, 4000));
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
