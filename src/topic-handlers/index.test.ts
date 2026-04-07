import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RegisteredGroup } from '../types.js';
import {
  _resetTopicHandlerRegistryForTests,
  getTopicHandler,
  loadTopicHandlersConfig,
  registerTopicHandler,
  type TopicHandler,
} from './index.js';

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
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

describe('topic-handlers registry', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetTopicHandlerRegistryForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-handlers-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadTopicHandlersConfig', () => {
    it('returns null when the config file does not exist', () => {
      expect(loadTopicHandlersConfig(path.join(tmpDir, 'missing.json'))).toBe(
        null,
      );
    });

    it('returns null when the JSON is malformed', () => {
      const file = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(file, '{ this is not json');
      expect(loadTopicHandlersConfig(file)).toBe(null);
    });

    it('parses a well-formed config into a topics map', () => {
      const file = path.join(tmpDir, 'good.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          topics: {
            '5': {
              name: 'Dairy',
              handler: 'diary',
              config: { mountName: 'notes' },
            },
          },
        }),
      );
      const cfg = loadTopicHandlersConfig(file);
      expect(cfg).not.toBeNull();
      expect(cfg?.topics['5'].handler).toBe('diary');
      expect(cfg?.topics['5'].config?.mountName).toBe('notes');
    });
  });

  describe('getTopicHandler', () => {
    function writeConfig(group: RegisteredGroup, contents: object): void {
      // Use a fake group whose folder we redirect via overrideConfigDir.
      const groupDir = path.join(tmpDir, group.folder);
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'topic-handlers.json'),
        JSON.stringify(contents),
      );
    }

    it('returns null when threadId is undefined (general topic)', () => {
      const group = makeGroup('test-group');
      writeConfig(group, {
        topics: { '5': { handler: 'stub', config: {} } },
      });
      registerTopicHandler('stub', () => ({
        name: 'stub',
        async handle() {
          return { consumed: true };
        },
      }));
      expect(
        getTopicHandler(group, undefined, { configRoot: tmpDir }),
      ).toBeNull();
    });

    it('returns null when no config file exists for the group', () => {
      const group = makeGroup('no-config-group');
      expect(getTopicHandler(group, '5', { configRoot: tmpDir })).toBeNull();
    });

    it('returns null when the threadId is not in the config', () => {
      const group = makeGroup('test-group');
      writeConfig(group, {
        topics: { '5': { handler: 'stub', config: {} } },
      });
      registerTopicHandler('stub', () => ({
        name: 'stub',
        async handle() {
          return { consumed: true };
        },
      }));
      expect(getTopicHandler(group, '99', { configRoot: tmpDir })).toBeNull();
    });

    it('returns the registered handler instance for a configured topic', () => {
      const group = makeGroup('test-group');
      writeConfig(group, {
        topics: { '5': { handler: 'stub', config: { extra: true } } },
      });
      let receivedConfig: unknown = null;
      registerTopicHandler('stub', (_g, cfg) => {
        receivedConfig = cfg;
        const handler: TopicHandler = {
          name: 'stub',
          async handle() {
            return { consumed: true };
          },
        };
        return handler;
      });

      const handler = getTopicHandler(group, '5', { configRoot: tmpDir });
      expect(handler).not.toBeNull();
      expect(handler?.name).toBe('stub');
      expect(receivedConfig).toEqual({ extra: true });
    });

    it('returns null and logs when the handler name is unknown', () => {
      const group = makeGroup('test-group');
      writeConfig(group, {
        topics: { '5': { handler: 'nonexistent', config: {} } },
      });
      expect(getTopicHandler(group, '5', { configRoot: tmpDir })).toBeNull();
    });

    it('caches handlers and re-reads when the config file is modified', () => {
      const group = makeGroup('test-group');
      writeConfig(group, {
        topics: { '5': { handler: 'stub', config: { v: 1 } } },
      });

      let constructCount = 0;
      let lastConfig: unknown = null;
      registerTopicHandler('stub', (_g, cfg) => {
        constructCount += 1;
        lastConfig = cfg;
        return {
          name: 'stub',
          async handle() {
            return { consumed: true };
          },
        };
      });

      getTopicHandler(group, '5', { configRoot: tmpDir });
      getTopicHandler(group, '5', { configRoot: tmpDir });
      expect(constructCount).toBe(1); // cached on second call

      // Bump the config and the mtime
      const file = path.join(tmpDir, group.folder, 'topic-handlers.json');
      const future = new Date(Date.now() + 5000);
      fs.writeFileSync(
        file,
        JSON.stringify({
          topics: { '5': { handler: 'stub', config: { v: 2 } } },
        }),
      );
      fs.utimesSync(file, future, future);

      getTopicHandler(group, '5', { configRoot: tmpDir });
      expect(constructCount).toBe(2);
      expect(lastConfig).toEqual({ v: 2 });
    });
  });
});
