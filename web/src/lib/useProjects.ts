import { useCallback, useEffect, useState } from 'react';
import { listProjects, type ProjectView } from './api.ts';

const STORAGE_KEY = 'ticketrail.project';
/** Where the choice was kept before the rename to Ticketrail. */
const LEGACY_STORAGE_KEY = 'promptkanban.project';

/**
 * The registry behind the switcher. Polled rather than streamed: it is one
 * small request, and the counts must keep updating for projects nobody is
 * currently watching.
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(data.projects);
      setDefaultId(data.defaultId);
    } catch {
      /* the board itself reports connection trouble */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { projects, defaultId, refresh };
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Which board is on screen. The URL wins so a board stays bookmarkable and
 * survives a reload; the last choice is the fallback, then whatever project
 * the server was started in.
 */
export function useSelectedProject(projects: ProjectView[], defaultId: string | null) {
  const [requested, setRequested] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('project') ?? readStored(),
  );

  const known = projects.some((p) => p.id === requested && !p.missing);
  const selected = known
    ? requested
    : (projects.find((p) => p.id === defaultId && !p.missing)?.id ??
      projects.find((p) => !p.missing)?.id ??
      null);

  const select = useCallback((id: string) => {
    setRequested(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private window */
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('project') === selected) return;
    url.searchParams.set('project', selected);
    window.history.replaceState(null, '', url);
  }, [selected]);

  useEffect(() => {
    const onPop = () => setRequested(new URLSearchParams(window.location.search).get('project'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return { selected, select };
}
