import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidGroupFolder,
  resolveAdditionalMountHostPath,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import type { RegisteredGroup } from './types.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

describe('resolveAdditionalMountHostPath', () => {
  function makeGroup(
    mounts: { hostPath: string; containerPath?: string }[],
  ): RegisteredGroup {
    return {
      name: 'main',
      folder: 'main',
      trigger: '@x',
      added_at: '2026-01-01T00:00:00Z',
      isMain: true,
      containerConfig: { additionalMounts: mounts },
    };
  }

  it('returns the absolute host path of a named mount', () => {
    const group = makeGroup([
      { hostPath: '/var/data/notes', containerPath: 'notes' },
    ]);
    expect(resolveAdditionalMountHostPath(group, 'notes')).toBe(
      '/var/data/notes',
    );
  });

  it('expands a leading ~ to the user home directory', () => {
    const group = makeGroup([{ hostPath: '~/notes', containerPath: 'notes' }]);
    expect(resolveAdditionalMountHostPath(group, 'notes')).toBe(
      path.join(os.homedir(), 'notes'),
    );
  });

  it('falls back to basename(hostPath) when containerPath is omitted', () => {
    const group = makeGroup([{ hostPath: '/var/data/notes' }]);
    expect(resolveAdditionalMountHostPath(group, 'notes')).toBe(
      '/var/data/notes',
    );
  });

  it('throws when the named mount does not exist', () => {
    const group = makeGroup([
      { hostPath: '/var/data/notes', containerPath: 'notes' },
    ]);
    expect(() => resolveAdditionalMountHostPath(group, 'photos')).toThrow(
      /no additional mount named "photos"/i,
    );
  });

  it('throws when the group has no containerConfig at all', () => {
    const group: RegisteredGroup = {
      name: 'main',
      folder: 'main',
      trigger: '@x',
      added_at: '2026-01-01T00:00:00Z',
    };
    expect(() => resolveAdditionalMountHostPath(group, 'notes')).toThrow();
  });
});
