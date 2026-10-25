import type { Agent, AgentSummary, Attachment, BoardSnapshot, Column, Folder, FolderColor, NotificationSettings, ImportResult, RepoScan, Skill, SkillSummary, Task, TaskType, WorkerPresence } from './types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // The router answers an unmatched /api/ path with exactly this. Every real
    // 404 names what was missing, so seeing it means the page is talking to a
    // server that predates the route -- the UI is served from disk and reloads
    // on refresh, while the server keeps its routes in memory until restarted.
    if (res.status === 404 && body.error === 'Not found') {
      throw new Error(
        `This board server does not have ${path}. It is probably running an older build — restart it (ticketrail serve) and reload.`,
      );
    }
    // the status lets a caller tell a conflict (409) from a plain failure
    throw Object.assign(new Error(body.error ?? `Request failed (${res.status})`), { status: res.status });
  }
  return (await res.json()) as T;
}

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  shortPath: string;
  missing: boolean;
  isDefault: boolean;
  summary: { queued: number; inProgress: number; blocked: number; done: number; total: number };
  workers?: WorkerPresence;
}

export const listProjects = () =>
  request<{ defaultId: string; projects: ProjectView[] }>('/api/projects');

/**
 * Registry calls, deliberately outside apiFor(): they are about which boards
 * exist, not about the contents of one.
 */

/** Opens the native folder chooser on the machine running the server. */
export const browseForFolder = () =>
  request<{ path?: string; cancelled?: boolean }>('/api/projects/browse', { method: 'POST', body: '{}' });

export const createProject = (path: string) =>
  request<{ created: boolean; project: ProjectView }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });

export const renameProject = (id: string, title: string) =>
  request<ProjectView>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });

export const deleteProject = (id: string) =>
  request<{ removed: { id: string; path: string } }>(`/api/projects/${id}`, { method: 'DELETE' });

/** Every call is scoped to one board, so the switcher cannot cross the wires. */
export function apiFor(projectId: string) {
  const base = `/api/projects/${projectId}`;
  return {
  board: () => request<BoardSnapshot>(`${base}/board`),

  settings: () =>
    request<{ title: string; notifications: NotificationSettings; keepSessions: boolean }>(`${base}/settings`),

  saveSettings: (notifications: Partial<NotificationSettings>) =>
    request<{ title: string; notifications: NotificationSettings; keepSessions: boolean }>(`${base}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ notifications }),
    }),

  /** Whether each run's session is saved with its card. */
  saveKeepSessions: (keepSessions: boolean) =>
    request<{ title: string; notifications: NotificationSettings; keepSessions: boolean }>(`${base}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ keepSessions }),
    }),

  /** Remove a card's sessions, history and saved copies. */
  clearSession: (id: string) => request<Task>(`${base}/tasks/${id}/session`, { method: 'DELETE' }),

  create: (input: { title: string; description?: string; column?: Column; type?: TaskType | null; labels?: string[] }) =>
    request<Task>(`${base}/tasks`, { method: 'POST', body: JSON.stringify(input) }),

  /** Spawn a Feature card from a finished investigation. */
  derive: (id: string) => request<Task>(`${base}/tasks/${id}/derive`, { method: 'POST' }),

  patch: (
    id: string,
    changes: Partial<{
      title: string;
      description: string;
      plan: string | null;
      labels: string[];
      type: TaskType | null;
      related: string[];
      folder: string | null;
      agent: string | null;
      worker: string | null;
      column: Column;
      before: string | null;
      after: string | null;
    }>,
  ) => request<Task>(`${base}/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),

  createFolder: (name: string, color?: FolderColor) =>
    request<Folder>(`${base}/folders`, { method: 'POST', body: JSON.stringify({ name, color }) }),

  updateFolder: (
    id: string,
    changes: Partial<{ name: string; color: FolderColor; before: string | null; after: string | null }>,
  ) => request<Folder>(`${base}/folders/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),

  /** The folder's cards are kept and become unfiled. */
  deleteFolder: (id: string) => request<Folder[]>(`${base}/folders/${id}`, { method: 'DELETE' }),

  archive: (id: string) => request<Task>(`${base}/tasks/${id}`, { method: 'DELETE' }),

  /** The File is posted as the raw body — no multipart, no base64 inflation. */
  upload: async (id: string, file: File): Promise<Attachment> => {
    const res = await fetch(`${base}/tasks/${id}/attachments`, {
      method: 'POST',
      body: file,
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name || 'pasted-file'),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `Upload failed (${res.status})`);
    }
    return (await res.json()) as Attachment;
  },

  removeAttachment: (id: string, fileId: string) =>
    request<Task>(`${base}/tasks/${id}/attachments/${fileId}`, { method: 'DELETE' }),

  reply: (id: string, text: string) =>
    request<Task>(`${base}/tasks/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),

  skills: () => request<SkillSummary[]>(`${base}/skills`),

  skill: (name: string) => request<Skill>(`${base}/skills/${encodeURIComponent(name)}`),

  createSkill: (input: { name: string; description: string }) =>
    request<Skill>(`${base}/skills`, { method: 'POST', body: JSON.stringify(input) }),

  /** `version` is the one the editor loaded; a 409 means the file moved on. */
  saveSkill: (name: string, raw: string, version: string, force = false) =>
    request<Skill>(`${base}/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ raw, version, force }),
    }),

  /** Clones the repository on the server; can take a while for a big one. */
  scanSkillRepo: (url: string) =>
    request<RepoScan>(`${base}/skills/import/scan`, { method: 'POST', body: JSON.stringify({ url }) }),

  importSkills: (scanId: string, paths: string[], overwrite: boolean) =>
    request<ImportResult>(`${base}/skills/import`, { method: 'POST', body: JSON.stringify({ scanId, paths, overwrite }) }),

  deleteSkills: (names: string[]) =>
    request<{ removed: string[]; failed: { name: string; reason: string }[] }>(`${base}/skills/delete`, {
      method: 'POST',
      body: JSON.stringify({ names }),
    }),

  deleteSkill: (name: string) =>
    request<{ removed: string }>(`${base}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  agents: () => request<AgentSummary[]>(`${base}/agents`),

  agent: (name: string) => request<Agent>(`${base}/agents/${encodeURIComponent(name)}`),

  createAgent: (input: { name: string; description: string; template: string }) =>
    request<Agent>(`${base}/agents`, { method: 'POST', body: JSON.stringify(input) }),

  /** `version` is the one the editor loaded; a 409 means the file moved on. */
  saveAgent: (name: string, raw: string, version: string, force = false) =>
    request<Agent>(`${base}/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ raw, version, force }),
    }),

  deleteAgent: (name: string) =>
    request<{ removed: string }>(`${base}/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  };
}

export type Api = ReturnType<typeof apiFor>;

/** Where an attachment is served from, for thumbnails and download links. */
export const fileUrl = (projectId: string, fileId: string, download = false) =>
  `/api/projects/${projectId}/files/${fileId}${download ? '?download=1' : ''}`;
