import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import type { RegisteredGroup } from './types.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the host filesystem path of an additional mount on a registered group,
 * looked up by its `containerPath` (or its hostPath basename if containerPath
 * is omitted). Throws if the group has no matching mount.
 *
 * Used by host-side handlers (e.g. the diary topic handler) that need to write
 * into a directory the agent container also has mounted.
 */
export function resolveAdditionalMountHostPath(
  group: RegisteredGroup,
  mountName: string,
): string {
  const mounts = group.containerConfig?.additionalMounts;
  if (!mounts || mounts.length === 0) {
    throw new Error(
      `Group "${group.folder}" has no additional mounts configured`,
    );
  }
  for (const m of mounts) {
    const name = m.containerPath ?? path.basename(m.hostPath);
    if (name === mountName) {
      return expandHome(m.hostPath);
    }
  }
  throw new Error(
    `Group "${group.folder}" has no additional mount named "${mountName}"`,
  );
}
