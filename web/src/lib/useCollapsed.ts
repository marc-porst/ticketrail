import { useCallback, useEffect, useState } from 'react';
import type { Column } from './types.ts';

const keyFor = (projectId: string) => `pk:collapsed:${projectId}`;
const entry = (column: Column, folderId: string) => `${column}:${folderId}`;

function load(projectId: string | null): Set<string> {
  if (!projectId) return new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(projectId)) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Which folder groups are collapsed, per lane. Remembered in this browser only:
 * collapsing is how you look at the board, not something Claude or anyone else
 * needs to see.
 */
export function useCollapsed(projectId: string | null) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => load(projectId));

  useEffect(() => setCollapsed(load(projectId)), [projectId]);

  const save = useCallback(
    (next: Set<string>) => {
      setCollapsed(next);
      if (!projectId) return;
      try {
        localStorage.setItem(keyFor(projectId), JSON.stringify([...next]));
      } catch {
        /* private window or storage blocked: it still works for this visit */
      }
    },
    [projectId],
  );

  const isCollapsed = useCallback((column: Column, folderId: string) => collapsed.has(entry(column, folderId)), [collapsed]);

  const toggle = useCallback(
    (column: Column, folderId: string) => {
      const next = new Set(collapsed);
      const key = entry(column, folderId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      save(next);
    },
    [collapsed, save],
  );

  const setAll = useCallback(
    (column: Column, folderIds: string[], value: boolean) => {
      const next = new Set(collapsed);
      for (const id of folderIds) {
        if (value) next.add(entry(column, id));
        else next.delete(entry(column, id));
      }
      save(next);
    },
    [collapsed, save],
  );

  return { isCollapsed, toggle, setAll };
}

export type Collapsed = ReturnType<typeof useCollapsed>;
