export type {
  ActivityEntry,
  Attachment,
  ActivityKind,
  Column,
  Message,
  Mode,
  PastResult,
  Task,
  TaskType,
} from '../../../src/core/task.ts';
export {
  COLUMNS,
  COLUMN_LABELS,
  COLUMN_HINTS,
  MAX_LABELS,
  MAX_LABEL_LENGTH,
  MAX_RELATED,
  TASK_TYPES,
  TYPE_LABELS,
  isReadOnlyType,
  normalizeTask,
  pendingQuestion,
} from '../../../src/core/task.ts';
export { formatBytes, isImage } from '../../../src/core/files.ts';
export type { Folder, FolderColor } from '../../../src/core/folder.ts';
export {
  FOLDER_COLORS,
  MAX_FOLDER_NAME,
  effectiveFolder,
  laneOrder,
  normalizeFolders,
} from '../../../src/core/folder.ts';
export { modelLabel } from '../../../src/core/model.ts';

export type { WaitingWorker, WorkerPresence } from '../../../src/core/presence.ts';
export type { Skill, SkillSummary } from '../../../src/core/skills.ts';
export type { Agent, AgentSummary } from '../../../src/core/agents.ts';
export { AGENT_TEMPLATES } from '../../../src/core/agent-templates.ts';
export type { ImportResult, RepoScan, RepoSkill } from '../../../src/core/skill-import.ts';
export { isSkillName, MAX_SKILL_DESCRIPTION, parseFrontmatter } from '../../../src/core/skill-rules.ts';

export interface ColumnMeta {
  id: import('../../../src/core/task.ts').Column;
  label: string;
  hint: string;
}

export interface Project {
  name: string;
  path: string;
  shortPath: string;
}

export interface NotificationSettings {
  sound: boolean;
  desktop: boolean;
  onStart: boolean;
}

export interface BoardSnapshot {
  title: string;
  /** Absent when an older server is serving this page. */
  settings?: NotificationSettings;
  /** Absent when an older server is serving this page. */
  project?: Project;
  columns: ColumnMeta[];
  /** Absent when an older server is serving this page. Empty on most boards. */
  folders?: import('../../../src/core/folder.ts').Folder[];
  tasks: import('../../../src/core/task.ts').Task[];
  /** Absent when an older server is serving this page. */
  workers?: import('../../../src/core/presence.ts').WorkerPresence;
}
