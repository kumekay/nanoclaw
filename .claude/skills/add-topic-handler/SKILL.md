---
name: add-topic-handler
description: Add a new per-topic handler that intercepts messages from a forum-style channel topic (currently Telegram supergroup topics) and runs custom code instead of the main agent loop. Use when the user wants a specific topic to do bounded ingestion, archiving, or transformation work — e.g. journaling, third-party API calls, transcription pipelines — without spawning a container per message.
---

# Add a Topic Handler

NanoClaw routes forum-topic messages through a per-topic dispatch system. By default every message in a registered group goes to the main agent. You can install a "topic handler" against a specific topic id so messages in that topic are consumed by your custom code and never reach the agent loop.

The canonical reference handler is `src/topic-handlers/diary.ts` — pure ingestion that archives voice/photo/text/video into a daily markdown journal. **Read it before scaffolding a new one.**

## When to use

- The user wants a specific Telegram topic to behave differently from the main chat
- The behavior is bounded: archiving, ingestion, fixed transformation, third-party calls, transcription
- They want to skip the latency and cost of a per-message container spawn

If they want the topic to still talk to Claude with a different prompt, that's a system-prompt change, not a topic handler.

## Architecture

| File | Purpose |
|------|---------|
| `src/topic-handlers/index.ts` | Registry, public types, mtime-cached config loader, `getTopicHandler()` |
| `src/topic-handlers/all.ts` | Self-registration barrel — every handler module is imported here |
| `src/topic-handlers/diary.ts` | Reference handler implementation |
| `src/topic-handlers/diary-format.ts` | Pure formatters extracted from `diary.ts` |
| `src/channels/telegram.ts` | Calls `getTopicHandler()` and dispatches via `tryTopicHandler()` |
| `groups/{folder}/topic-handlers.json` | Per-group config: maps topic ids to handler names |

Handlers self-register by name. Each handler module calls `registerTopicHandler('name', factory)` at module load. The barrel `all.ts` imports each module so the side effect runs at startup. The per-group JSON references handlers by that name.

`topic-handlers.json` is mtime-cached: editing it does **not** require a service restart. New handler code (a new `.ts` file) does.

## Workflow

### 1. Clarify the request

Use `AskUserQuestion` to nail down:
- **What should the handler do?** (the core behavior)
- **Which media kinds matter?** Possible kinds: `text`, `voice`, `audio`, `photo`, `video`, `video_note`, `document`. Plain text comes through with `ctx.media === undefined`.
- **External services?** OpenAI, HTTP APIs, filesystem mounts
- **Per-group config knobs?** e.g. mount name, model name, output subdir
- **Which group + topic id?** They can run `/topicid` inside the target topic to discover the integer id.

### 2. Scaffold the handler module

Create `src/topic-handlers/{name}.ts`. Mirror `diary.ts`:

```ts
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import {
  registerTopicHandler,
  type TopicHandler,
  type TopicHandlerContext,
  type TopicHandlerResult,
} from './index.js';

export interface MyHandlerConfig {
  // user-tunable knobs from topic-handlers.json
}

export interface MyHandlerDeps {
  now: () => Date;
  // anything time/IO/network — inject so tests can mock
}

class MyHandler implements TopicHandler {
  readonly name = 'my-handler';

  constructor(
    private readonly group: RegisteredGroup,
    private readonly config: MyHandlerConfig,
    private readonly deps: MyHandlerDeps,
  ) {}

  async handle(ctx: TopicHandlerContext): Promise<TopicHandlerResult> {
    try {
      // ctx.media may be undefined (text-only)
      // ctx.message.content has the text/caption
      // ctx.reply(text, { parseMode: 'HTML' }) for confirmation
    } catch (err) {
      logger.error(
        { err, threadId: ctx.threadId, group: this.group.folder },
        'my-handler failed',
      );
    }
    return { consumed: true };
  }
}

export function createMyHandler(
  group: RegisteredGroup,
  config: MyHandlerConfig,
  deps: MyHandlerDeps,
): TopicHandler {
  return new MyHandler(group, config, deps);
}

function defaultDeps(): MyHandlerDeps {
  return { now: () => new Date() };
}

registerTopicHandler('my-handler', (group, rawConfig) => {
  const cfg = (rawConfig ?? {}) as MyHandlerConfig;
  return new MyHandler(group, cfg, defaultDeps());
});
```

### Invariants

- **Always return `{ consumed: true }`** when the handler is responsible for the topic, even on internal failure. Returning `false` makes the message fall through to the agent loop, which will pollute the agent's session history with topic messages. Better to log and consume than to leak.
- **Catch errors inside `handle()`**. The dispatcher in `telegram.ts` already wraps the call in a try/catch as a safety net (and falls through on throw), but you usually want the handler to own its failures so users still get feedback.
- **Inject dependencies** (clocks, network, filesystem) so the handler can be unit-tested without real I/O. See `DiaryHandlerDeps` for the pattern.

### 3. Register in the barrel

Edit `src/topic-handlers/all.ts` and add the import:

```ts
import './my-handler.js';
```

Order doesn't matter — each module's `registerTopicHandler()` runs once at startup.

### 4. Write tests (red-green TDD)

The diary handler was built with TDD. Mirror its test layout:

- `src/topic-handlers/{name}.test.ts` — handler-level tests with injected deps
- `src/topic-handlers/{name}-format.test.ts` if you extract pure formatters

`src/topic-handlers/diary.test.ts` is the model: `vi.fn()` mocks for deps cast as `as any`, a `buildContext()` factory, `beforeEach` that creates a temp dir, separate `describe` blocks per media kind.

If the handler is dispatched via Telegram, also extend `src/channels/telegram.test.ts` — the existing "topic handler dispatch" describe block shows how to mock the registry and assert wiring.

### 5. Configure the group

Create or edit `groups/{folder}/topic-handlers.json`:

```json
{
  "topics": {
    "<topic-id>": {
      "name": "Display Name",
      "handler": "my-handler",
      "config": {
        "knob1": "value"
      }
    }
  }
}
```

- `<topic-id>` — integer Telegram topic id, **as a string**
- `handler` — must match the name passed to `registerTopicHandler()`
- `config` — forwarded to the factory's second arg as `Record<string, unknown>`
- `name` — informational; helps the user remember what this topic is

Multiple topics can be configured per group; each entry is independent.

### 6. Build, test, restart

```bash
npm run build
npx vitest run src/topic-handlers/
sudo systemctl restart nanoclaw
```

Restart is required because the new handler module loads at startup. **Subsequent edits to `topic-handlers.json` alone do not need a restart** — `getTopicHandler()` re-reads the file when its mtime changes.

### 7. Verify end-to-end

Send a message in the target topic. Confirm:
1. The handler's `reply()` posts a confirmation (if it sends one)
2. The main agent does **not** also respond — the message should not appear in the container's session history
3. `/home/ku/p/kumekay/nanoclaw/logs/nanoclaw.log` shows no errors

If the handler doesn't fire:
- Send `/topicid` in the topic — does the id match the JSON?
- Is the handler name in the JSON spelled exactly the same as in `registerTopicHandler('...')`?
- Is the new module imported in `all.ts`?
- Did the build succeed? (`npm run build` exit 0)

## Common patterns (steal from `diary.ts`)

### OpenAI calls (vision, transcription)
Inject the API as a dep: `transcribeAudio`, `describeImage`, `extractAudioFromVideo`. Reuse the wrappers in `src/transcription.ts` and `src/image-caption.ts` for the production factory; mock them in tests.

### Writing to a mounted directory
Use `resolveAdditionalMountHostPath(group, mountName)` from `src/group-folder.js` to translate a mount name (as configured in `RegisteredGroup.containerConfig.additionalMounts`) into an absolute host path. The diary handler resolves its journal root this way.

### Strict append-only writes
Use `fs.appendFileSync` only — never read+rewrite. See `appendEntry()` in `diary.ts`.

### Timezone-aware filenames and headers
`Intl.DateTimeFormat` with `en-CA` and `hourCycle: 'h23'` gives sortable parts. See `getLocalParts()` in `diary.ts`. Use the project's `TIMEZONE` from `src/config.ts`.

### URL-safe media filenames
Avoid colons in filenames — markdown viewers (Obsidian) mishandle `%3A`. Use `YYYY-MM-DD HH-MM-SS.ext` (space + hyphens). The diary handler's `localFullStamp()` is the convention.

### HTML reply with collapsible content
Telegram supports `<blockquote expandable>...</blockquote>` for collapsible blocks. Pass `{ parseMode: 'HTML' }` to `ctx.reply` and HTML-escape user content first.

## Discovering ids the user needs

- **Chat id**: send `/chatid` in the target chat — bot replies with the `tg:...` jid stored in `registered_groups`. Supergroups are negative (`-100…`), DMs are positive. To migrate a registered group from a DM to a supergroup:
  ```bash
  sqlite3 /home/ku/p/kumekay/nanoclaw/store/messages.db \
    "UPDATE registered_groups SET jid='tg:<new-id>' WHERE folder='<folder>';"
  sudo systemctl restart nanoclaw
  ```
  The chat-id change requires a restart (the in-memory groups map loads at startup).

- **Topic id**: send `/topicid` inside the target forum topic. The General topic has no thread id and falls through to the main agent loop by design.

## Caveats

- **Telegram bot privacy mode**: For the bot to receive plain messages in groups, talk to @BotFather → `/setprivacy` → select the bot → `Disable`, then **remove and re-add** the bot to the group (the change only takes effect on a fresh group join). Verify with `getMe` — `can_read_all_group_messages` should be `true`.
- **Currently registered handlers**: `diary`. Any new handler must be added to `src/topic-handlers/all.ts` and self-register via `registerTopicHandler(name, factory)`.
- **General topic vs. specific topics**: in a forum supergroup, messages in the General topic have `message_thread_id === undefined` and bypass the topic handler dispatch entirely. Topic handlers only fire when a thread id is present.
