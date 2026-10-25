#!/usr/bin/env node

// src/core/store.ts
import fs5 from "fs";
import path6 from "path";

// src/core/paths.ts
import fs from "fs";
import path from "path";
var DATA_DIR = ".ticketrail";
var LEGACY_DATA_DIR = ".promptkanban";
function dataDirName(root) {
  if (!fs.existsSync(path.join(root, DATA_DIR)) && fs.existsSync(path.join(root, LEGACY_DATA_DIR))) {
    return LEGACY_DATA_DIR;
  }
  return DATA_DIR;
}
function envVar(name) {
  return process.env[`TICKETRAIL_${name}`] ?? process.env[`PROMPTKANBAN_${name}`];
}
function pathsFor(root) {
  const data = path.join(root, dataDirName(root));
  return {
    root,
    data,
    tasks: path.join(data, "tasks"),
    files: path.join(data, "files"),
    sessions: path.join(data, "sessions"),
    locks: path.join(data, ".locks"),
    runtime: path.join(data, ".runtime"),
    workers: path.join(data, ".runtime", "workers"),
    config: path.join(data, "config.json"),
    folders: path.join(data, "folders.json"),
    boardLock: path.join(data, ".locks", "board.lock"),
    serverInfo: path.join(data, ".runtime", "server.json")
  };
}
function hasBoard(dir) {
  return fs.existsSync(path.join(dir, dataDirName(dir), "config.json"));
}
function linkedWorktree(dir) {
  try {
    const dotGit = path.join(dir, ".git");
    if (!fs.statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!match) return null;
    const gitdir = path.resolve(dir, match[1].trim());
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
    if (path.basename(common) !== ".git") return null;
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
    return { path: dir, branch, main: path.dirname(common) };
  } catch {
    return null;
  }
}
function findRoot(start = process.cwd()) {
  const forced = envVar("ROOT");
  if (forced) return hasBoard(forced) ? path.resolve(forced) : null;
  let dir = path.resolve(start);
  for (; ; ) {
    const worktree = linkedWorktree(dir);
    if (worktree && hasBoard(worktree.main)) return worktree.main;
    if (hasBoard(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function findWorktree(start = process.cwd()) {
  let dir = path.resolve(start);
  for (; ; ) {
    const worktree = linkedWorktree(dir);
    if (worktree) return worktree;
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function requireRoot(start) {
  const root = findRoot(start);
  if (!root) {
    throw new Error(
      `No Ticketrail board found in this directory or any parent.
Run "ticketrail init" first (or /ticketrail-start in Claude Code).`
    );
  }
  return root;
}

// src/core/lock.ts
import fs2 from "fs";
import path2 from "path";
var STALE_MS = 1e4;
var RETRY_MS = 15;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLock(lockPath2, fn, timeoutMs2 = 5e3) {
  const start = Date.now();
  fs2.mkdirSync(path2.dirname(lockPath2), { recursive: true });
  for (; ; ) {
    try {
      fs2.mkdirSync(lockPath2);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = fs2.statSync(lockPath2);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          fs2.rmSync(lockPath2, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs2) {
        throw new Error(`Timed out waiting for the board lock (${lockPath2})`);
      }
      sleepSync(RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs2.rmSync(lockPath2, { recursive: true, force: true });
    } catch {
    }
  }
}

// src/core/order.ts
var BEFORE_A = 96;
var AFTER_Z = 123;
function midString(prev, next) {
  let p = 0;
  let n = 0;
  let pos = 0;
  for (pos = 0; p === n; pos++) {
    p = pos < prev.length ? prev.charCodeAt(pos) : BEFORE_A;
    n = pos < next.length ? next.charCodeAt(pos) : AFTER_Z;
  }
  let str = prev.slice(0, pos - 1);
  if (p === BEFORE_A) {
    while (n === 97) {
      n = pos < next.length ? next.charCodeAt(pos++) : AFTER_Z;
      str += "a";
    }
    if (n === 98) {
      str += "a";
      n = AFTER_Z;
    }
  } else if (p + 1 === n) {
    str += String.fromCharCode(p);
    n = AFTER_Z;
    while ((p = pos < prev.length ? prev.charCodeAt(pos++) : BEFORE_A) === 122) {
      str += "z";
    }
  }
  return str + String.fromCharCode(Math.ceil((p + n) / 2));
}
function orderBetween(prev, next) {
  return midString(prev ?? "", next ?? "");
}
function orderFirst(keys) {
  const sorted = [...keys].sort();
  return orderBetween("", sorted[0] ?? "");
}
function orderLast(keys) {
  const sorted = [...keys].sort();
  return orderBetween(sorted[sorted.length - 1] ?? "", "");
}

// src/core/files.ts
import path3 from "path";
var EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "video/mp4": "mp4",
  "video/quicktime": "mov"
};
var MIME_BY_EXT = {
  ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  jpeg: "image/jpeg",
  yml: "text/plain",
  yaml: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  log: "text/plain"
};
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function safeExtension(name, mime) {
  const fromName = path3.extname(name).replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[mime] ?? "";
}
function mimeForExtension(ext) {
  return MIME_BY_EXT[ext.replace(/^\./, "").toLowerCase()] ?? "application/octet-stream";
}
function displayName(name, fallback) {
  const base = path3.basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 120) : fallback;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// src/core/model.ts
import fs3 from "fs";
import os from "os";
import path4 from "path";
var TAIL_BYTES = 256 * 1024;
var SYNTHETIC = "<synthetic>";
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR ?? path4.join(os.homedir(), ".claude");
}
function findTranscript(sessionId, home = claudeHome()) {
  if (!sessionId) return null;
  const projects = path4.join(home, "projects");
  let dirs;
  try {
    dirs = fs3.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path4.join(projects, dir, `${sessionId}.jsonl`);
    if (fs3.existsSync(file)) return file;
  }
  return null;
}
function modelFromTranscript(file) {
  let size;
  try {
    size = fs3.statSync(file).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - TAIL_BYTES);
  let text;
  try {
    const fd = fs3.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs3.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs3.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant" || record.isSidechain === true) continue;
    const model = record.message?.model;
    if (typeof model === "string" && model && model !== SYNTHETIC) return model;
  }
  return null;
}
function currentSession() {
  const id = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  const transcript = findTranscript(id);
  return transcript ? { id, transcript } : null;
}
function resolveModel(explicit) {
  const direct = explicit ?? envVar("MODEL");
  if (direct) return direct;
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  const transcript = findTranscript(sessionId);
  if (transcript) {
    const model = modelFromTranscript(transcript);
    if (model) return model;
  }
  return process.env.ANTHROPIC_MODEL || null;
}
function modelLabel(model) {
  const bare = model.replace(/\[[^\]]*\]$/, "");
  if (!bare.startsWith("claude-")) return model;
  const parts = bare.slice("claude-".length).split("-");
  const family = parts.shift();
  if (!family) return model;
  if (parts.length && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
  if (!parts.every((p) => /^\d+$/.test(p))) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return parts.length ? `${name} ${parts.join(".")}` : name;
}

// src/core/transcript.ts
import fs4 from "fs";
import path5 from "path";
var MAX_READ_BYTES = 8 * 1024 * 1024;
var MAX_OUTPUT = 4e3;
var MAX_SUMMARY = 160;
function readTranscript(file, from, to, maxBytes = MAX_READ_BYTES) {
  let size;
  try {
    size = fs4.statSync(file).size;
  } catch {
    return { records: [], next: from, clipped: false };
  }
  const end = Math.min(to ?? size, size);
  if (end <= from) return { records: [], next: from, clipped: false };
  const start = Math.max(from, end - maxBytes);
  const clipped = start > from;
  let buf;
  try {
    const fd = fs4.openSync(file, "r");
    try {
      buf = Buffer.alloc(end - start);
      fs4.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs4.closeSync(fd);
    }
  } catch {
    return { records: [], next: from, clipped: false };
  }
  const first = clipped ? buf.indexOf(10) + 1 : 0;
  const last = buf.lastIndexOf(10);
  if (last < first) return { records: [], next: clipped ? start : from, clipped };
  const records = [];
  let offset = start + first;
  for (const line of buf.subarray(first, last + 1).toString("utf8").split("\n")) {
    const at = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") records.push({ ...record, __offset: at });
    } catch {
    }
  }
  return { records, next: start + last + 1, clipped };
}
function oneLine(text, max = MAX_SUMMARY) {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
function relative(file, root) {
  if (!root || !path5.isAbsolute(file)) return file;
  const rel = path5.relative(root, file);
  return rel && !rel.startsWith("..") && !path5.isAbsolute(rel) ? rel : file;
}
function describeTool(name, input, root) {
  const str = (key) => typeof input?.[key] === "string" ? input[key] : "";
  switch (name) {
    case "Bash": {
      const command = str("command");
      const description = str("description");
      return description ? { summary: oneLine(description), detail: command } : { summary: oneLine(command) };
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { summary: relative(str("file_path") || str("notebook_path"), root) };
    case "Grep":
    case "Glob": {
      const where = str("path");
      return { summary: oneLine(where ? `${str("pattern")} in ${relative(where, root)}` : str("pattern")) };
    }
    case "Agent":
    case "Task":
      return { summary: oneLine(str("description") || str("prompt")), detail: str("prompt") || void 0 };
    case "WebFetch":
      return { summary: str("url") };
    case "WebSearch":
      return { summary: oneLine(str("query")) };
    case "Skill":
      return { summary: str("skill") };
    case "TodoWrite":
      return { summary: "Updated the to-do list" };
    default: {
      const first = Object.values(input ?? {}).find((v) => typeof v === "string");
      return { summary: first ? oneLine(first) : "" };
    }
  }
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.type === "text" ? String(block.text ?? "") : block?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
}
function cut(text) {
  if (text.length <= MAX_OUTPUT) return { output: text };
  const kept = text.slice(0, MAX_OUTPUT);
  const more = text.slice(MAX_OUTPUT).split("\n").length - (text[MAX_OUTPUT - 1] === "\n" ? 0 : 1);
  return { output: kept, more: Math.max(1, more) };
}
function toSessionEntries(records, options = {}) {
  const names = options.names ?? /* @__PURE__ */ new Map();
  const entries = [];
  for (const record of records) {
    if (record?.isMeta) continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    const at = typeof record.timestamp === "string" ? record.timestamp : (/* @__PURE__ */ new Date()).toISOString();
    const base = `${record.__offset ?? record.uuid ?? entries.length}`;
    const subagent = record.isSidechain === true ? { subagent: true } : {};
    content.forEach((block, i) => {
      const id = `${base}:${i}`;
      if (record.type === "assistant") {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          entries.push({ id, at, kind: "text", text: block.text, ...subagent });
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") names.set(block.id, block.name);
          const { summary, detail } = describeTool(block.name, block.input, options.root);
          entries.push({
            id,
            at,
            kind: "tool",
            tool: block.name,
            ...typeof block.id === "string" ? { toolId: block.id } : {},
            summary,
            ...detail && detail !== summary ? { detail } : {},
            ...subagent
          });
        }
      } else if (record.type === "user" && block?.type === "tool_result") {
        const toolId = typeof block.tool_use_id === "string" ? block.tool_use_id : void 0;
        const tool = toolId ? names.get(toolId) : void 0;
        entries.push({
          id,
          at,
          kind: "result",
          ...tool ? { tool } : {},
          ...toolId ? { toolId } : {},
          ...cut(resultText(block.content)),
          ...block.is_error === true ? { error: true } : {},
          ...subagent
        });
      }
    });
  }
  return entries;
}
function isTranscriptPath(file, home) {
  if (!path5.isAbsolute(file) || path5.extname(file) !== ".jsonl") return false;
  let real;
  let projects;
  try {
    real = fs4.realpathSync(file);
    projects = fs4.realpathSync(path5.join(home, "projects"));
  } catch {
    return false;
  }
  const rel = path5.relative(projects, real);
  return Boolean(rel) && !rel.startsWith("..") && !path5.isAbsolute(rel);
}
var AGENT_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
var MAX_SUBAGENT_ENTRIES = 1e3;
function subagentDir(transcript) {
  return path5.join(path5.dirname(transcript), path5.basename(transcript, ".jsonl"), "subagents");
}
var SessionReader = class {
  constructor(transcript, from, root, maxBytes = MAX_READ_BYTES) {
    this.transcript = transcript;
    this.root = root;
    this.maxBytes = maxBytes;
    this.next = from;
  }
  transcript;
  root;
  maxBytes;
  /** The main transcript's offset to resume from. */
  next;
  /** Some of the run's start was not read. */
  clipped = false;
  names = /* @__PURE__ */ new Map();
  /** Agent calls seen so far, in the worker's run and inside its subagents. */
  calls = /* @__PURE__ */ new Set();
  /** Subagent transcripts being followed, by file. */
  agents = /* @__PURE__ */ new Map();
  /** meta.json files already matched, so they are parsed once. */
  matched = /* @__PURE__ */ new Set();
  /** Everything new since the last read, up to `to` in the main transcript (or its end). */
  read(to) {
    const main2 = readTranscript(this.transcript, this.next, to, this.maxBytes);
    if (main2.clipped) this.clipped = true;
    this.next = main2.next;
    const out = this.track(toSessionEntries(main2.records, { root: this.root, names: this.names }));
    if (this.calls.size) out.push(...this.readAgents());
    return out;
  }
  track(entries) {
    for (const e of entries) {
      if (e.kind === "tool" && e.toolId && e.tool && AGENT_TOOLS.has(e.tool)) this.calls.add(e.toolId);
    }
    return entries;
  }
  readAgents() {
    const dir = subagentDir(this.transcript);
    let files;
    try {
      files = fs4.readdirSync(dir);
    } catch {
      return [];
    }
    this.match(dir, files);
    const out = [];
    for (let round = 0; round < 4; round++) {
      let found = false;
      for (const [file, state] of this.agents) {
        const read = readTranscript(file, state.offset, null, this.maxBytes);
        state.offset = read.next;
        const entries = toSessionEntries(read.records, { root: this.root, names: this.names });
        if (!entries.length) continue;
        found = true;
        this.track(entries);
        for (const e of entries) {
          if (state.count >= MAX_SUBAGENT_ENTRIES) break;
          state.count++;
          out.push({ ...e, id: `${state.agent}:${e.id}`, subagent: true, parent: e.parent ?? state.parent });
        }
      }
      if (!found) break;
      const before = this.agents.size;
      this.match(dir, files);
      if (this.agents.size === before) break;
    }
    return out;
  }
  /** Start following every subagent whose Agent call this run made. */
  match(dir, files) {
    for (const name of files) {
      if (!name.endsWith(".meta.json") || this.matched.has(name)) continue;
      try {
        const meta = JSON.parse(fs4.readFileSync(path5.join(dir, name), "utf8"));
        if (typeof meta?.toolUseId !== "string" || !this.calls.has(meta.toolUseId)) continue;
        const agent = name.slice(0, -".meta.json".length);
        this.matched.add(name);
        this.agents.set(path5.join(dir, `${agent}.jsonl`), { offset: 0, parent: meta.toolUseId, agent, count: 0 });
      } catch {
      }
    }
  }
};
function lastEntries(entries, max) {
  const own = entries.filter((e) => !e.parent);
  if (own.length <= max) return { entries, cut: false };
  const kept = new Set(own.slice(-max).map((e) => e.id));
  const calls = new Set(own.slice(-max).flatMap((e) => e.toolId ? [e.toolId] : []));
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries) {
      if (e.parent && calls.has(e.parent) && e.kind === "tool" && e.toolId && !calls.has(e.toolId)) {
        calls.add(e.toolId);
        grew = true;
      }
    }
  }
  return { entries: entries.filter((e) => kept.has(e.id) || e.parent !== void 0 && calls.has(e.parent)), cut: true };
}

// src/core/skill-rules.ts
var SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,63}$/;
var MAX_SKILL_DESCRIPTION = 1024;
var MANAGED_SKILLS = ["ticketrail"];
function isSkillName(value) {
  return typeof value === "string" && value.length <= 64 && SKILL_NAME.test(value);
}
function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    const opened = /^---[ \t]*\r?\n/.test(text);
    return { frontmatter: {}, body: text, valid: !opened };
  }
  const frontmatter = {};
  const lines = match[1].split(/\r?\n/);
  let valid = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) {
      valid = false;
      continue;
    }
    const [, key, rest] = kv;
    const block = /^([>|])[+-]?\s*$/.exec(rest);
    if (block || rest === "") {
      const taken = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        taken.push(lines[++i].trim());
      }
      while (taken.length && !taken[taken.length - 1]) taken.pop();
      frontmatter[key] = block?.[1] === "|" ? taken.join("\n") : taken.map((t) => t.replace(/^-\s+/, "")).join(block ? " " : ", ").replace(/\s+/g, " ").trim();
      continue;
    }
    frontmatter[key] = unquote(rest.trim());
  }
  return { frontmatter, body: text.slice(match[0].length), valid };
}
function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' && value.endsWith('"') || value[0] === "'" && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    return value[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  return value;
}

// src/core/folder.ts
var FOLDER_COLORS = ["slate", "rose", "amber", "lime", "emerald", "sky", "violet", "fuchsia"];
var MAX_FOLDER_NAME = 48;
function isFolderColor(value) {
  return typeof value === "string" && FOLDER_COLORS.includes(value);
}
function cleanFolderName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_NAME) : "";
}
function normalizeFolders(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.folders) ? raw.folders : [];
  const out = [];
  for (const f of list) {
    const name = cleanFolderName(f?.name);
    if (typeof f?.id !== "string" || !name || out.some((o) => o.id === f.id)) continue;
    out.push({
      id: f.id,
      name,
      color: isFolderColor(f?.color) ? f.color : "slate",
      order: typeof f?.order === "string" && f.order ? f.order : "n",
      createdAt: typeof f?.createdAt === "string" ? f.createdAt : (/* @__PURE__ */ new Date(0)).toISOString()
    });
  }
  return out.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.createdAt < b.createdAt ? -1 : 1);
}
function laneOrder(tasks, folders) {
  const rank = new Map(folders.map((f, i) => [f.id, i]));
  const group = (t) => t.folder && rank.has(t.folder) ? rank.get(t.folder) : -1;
  return [...tasks].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.number - b.number;
  });
}

// src/core/task.ts
var COLUMNS = [
  "backlog",
  "plan",
  "user-input",
  "implement",
  "in-progress",
  "planned",
  "done"
];
var COLUMN_LABELS = {
  backlog: "Backlog",
  plan: "Plan",
  "user-input": "User Input",
  implement: "Implement",
  "in-progress": "In Progress",
  planned: "Planned",
  done: "Done"
};
var COLUMN_HINTS = {
  backlog: "Not touched by Claude. Draft cards here.",
  plan: "Queued for Claude to plan.",
  "user-input": "Waiting for your answer.",
  implement: "Queued for Claude to build. Top card first.",
  "in-progress": "Claude is working on this right now.",
  planned: "Plan ready for your review.",
  done: "Finished."
};
var QUEUE_COLUMNS = ["implement", "plan"];
var TASK_TYPES = ["feature", "bug", "investigation", "question"];
var TYPE_LABELS = {
  feature: "Feature",
  bug: "Bug",
  investigation: "Investigation",
  question: "Question"
};
var READ_ONLY_TYPES = ["investigation", "question"];
function isTaskType(value) {
  return typeof value === "string" && TASK_TYPES.includes(value);
}
function isReadOnlyType(type) {
  return type !== null && READ_ONLY_TYPES.includes(type);
}
var MAX_LABELS = 8;
var MAX_LABEL_LENGTH = 32;
function normalizeLabels(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const label = raw.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length === MAX_LABELS) break;
  }
  return out;
}
var MAX_RELATED = 12;
function normalizeRelated(values, selfId) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const raw of values) {
    if (typeof raw !== "string" || !raw || raw === selfId || out.includes(raw)) continue;
    out.push(raw);
    if (out.length === MAX_RELATED) break;
  }
  return out;
}
var MAX_RESULT_HISTORY = 20;
var MAX_SESSION_HISTORY = 20;
var RUN_ID = /^[A-Za-z0-9_-]{1,40}$/;
function isColumn(value) {
  return typeof value === "string" && COLUMNS.includes(value);
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function makeId(prefix = "t") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
var WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
function isWorkerName(value) {
  return typeof value === "string" && WORKER_NAME.test(value);
}
function normalizeTask(raw, fallbackId) {
  const created = typeof raw?.createdAt === "string" ? raw.createdAt : now();
  const id = typeof raw?.id === "string" ? raw.id : fallbackId;
  return {
    id,
    number: Number.isFinite(raw?.number) ? Number(raw.number) : 0,
    title: typeof raw?.title === "string" ? raw.title : "Untitled",
    description: typeof raw?.description === "string" ? raw.description : "",
    column: isColumn(raw?.column) ? raw.column : "backlog",
    order: typeof raw?.order === "string" && raw.order ? raw.order : "n",
    type: isTaskType(raw?.type) ? raw.type : null,
    derivedFrom: typeof raw?.derivedFrom === "string" ? raw.derivedFrom : null,
    related: normalizeRelated(raw?.related, id),
    folder: typeof raw?.folder === "string" && raw.folder ? raw.folder : null,
    agent: isSkillName(raw?.agent) ? raw.agent : null,
    worker: isWorkerName(raw?.worker) ? raw.worker : null,
    claimedBy: typeof raw?.claimedBy === "string" && raw.claimedBy ? raw.claimedBy : null,
    model: typeof raw?.model === "string" && raw.model ? raw.model : null,
    session: normalizeSession(raw?.session),
    sessionHistory: Array.isArray(raw?.sessionHistory) ? raw.sessionHistory.filter((r) => typeof r?.run === "string" && RUN_ID.test(r.run)).map((r) => ({
      run: r.run,
      startedAt: typeof r?.startedAt === "string" ? r.startedAt : null,
      endedAt: typeof r?.endedAt === "string" ? r.endedAt : created,
      mode: r?.mode === "plan" || r?.mode === "implement" ? r.mode : null
    })).slice(-MAX_SESSION_HISTORY) : [],
    mode: raw?.mode === "plan" || raw?.mode === "implement" ? raw.mode : null,
    returnColumn: isColumn(raw?.returnColumn) ? raw.returnColumn : null,
    plan: typeof raw?.plan === "string" ? raw.plan : null,
    result: typeof raw?.result === "string" ? raw.result : null,
    resultHistory: Array.isArray(raw?.resultHistory) ? raw.resultHistory.filter((r) => typeof r?.text === "string").map((r) => ({ at: typeof r?.at === "string" ? r.at : created, text: r.text })).slice(-MAX_RESULT_HISTORY) : [],
    labels: normalizeLabels(raw?.labels),
    attachments: Array.isArray(raw?.attachments) ? raw.attachments.filter((a) => typeof a?.id === "string").map((a) => ({
      id: a.id,
      name: typeof a?.name === "string" ? a.name : a.id,
      mime: typeof a?.mime === "string" ? a.mime : "application/octet-stream",
      size: Number.isFinite(a?.size) ? Number(a.size) : 0,
      addedAt: typeof a?.addedAt === "string" ? a.addedAt : created,
      addedBy: a?.addedBy === "claude" ? "claude" : "user"
    })) : [],
    activity: Array.isArray(raw?.activity) ? raw.activity.map((a) => ({
      at: typeof a?.at === "string" ? a.at : created,
      kind: ["info", "file", "test", "status", "error"].includes(a?.kind) ? a.kind : "info",
      text: String(a?.text ?? ""),
      ...typeof a?.model === "string" && a.model ? { model: a.model } : {}
    })) : [],
    messages: Array.isArray(raw?.messages) ? raw.messages.map((m, i) => ({
      id: typeof m?.id === "string" ? m.id : `m${i}`,
      at: typeof m?.at === "string" ? m.at : created,
      role: m?.role === "user" ? "user" : "claude",
      text: String(m?.text ?? ""),
      ...m?.needsAnswer ? { needsAnswer: true } : {},
      ...typeof m?.answeredBy === "string" ? { answeredBy: m.answeredBy } : {}
    })) : [],
    createdAt: created,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : created,
    startedAt: typeof raw?.startedAt === "string" ? raw.startedAt : null,
    finishedAt: typeof raw?.finishedAt === "string" ? raw.finishedAt : null,
    cancelRequested: raw?.cancelRequested === true,
    archived: raw?.archived === true
  };
}
function isOffset(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function normalizeSession(raw) {
  if (typeof raw?.id !== "string" || !raw.id) return null;
  if (typeof raw?.transcript !== "string" || !raw.transcript) return null;
  if (!isOffset(raw?.from)) return null;
  const to = isOffset(raw?.to) && raw.to >= raw.from ? raw.to : null;
  return {
    id: raw.id,
    transcript: raw.transcript,
    from: raw.from,
    to,
    // sessions recorded before runs were saved get a stable id of their own
    run: typeof raw?.run === "string" && RUN_ID.test(raw.run) ? raw.run : `r${raw.from}`,
    startedAt: typeof raw?.startedAt === "string" ? raw.startedAt : null,
    saved: raw?.saved === true
  };
}
function pendingQuestion(task) {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const m = task.messages[i];
    if (m.role === "claude" && m.needsAnswer && !m.answeredBy) return m;
  }
  return null;
}

// src/core/store.ts
var DEFAULT_CONFIG = {
  version: 1,
  port: 4321,
  title: "Ticketrail",
  notifications: { sound: true, desktop: true, onStart: false },
  recordModel: true,
  liveSession: true,
  keepSessions: true
};
function refuse(status, message) {
  return Object.assign(new Error(message), { status });
}
function requireWorkerName(name) {
  if (!isWorkerName(name)) throw refuse(400, `"${name}" is not a usable worker name`);
  return name;
}
function requireAgentName(name) {
  if (!isSkillName(name)) throw refuse(400, `"${name}" is not a valid agent name`);
  return name;
}
function writeJsonAtomic(file, data) {
  const dir = path6.dirname(file);
  const tmp = path6.join(dir, `.tmp-${path6.basename(file)}-${process.pid}-${Date.now()}`);
  fs5.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs5.renameSync(tmp, file);
}
function sizeOf(file) {
  try {
    return fs5.statSync(file).size;
  } catch {
    return null;
  }
}
var MAX_SAVED_ENTRIES = 2e3;
function readJson(file) {
  try {
    return JSON.parse(fs5.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
var Store = class _Store {
  root;
  paths;
  /**
   * The model driving this process, stamped onto the status changes Claude
   * makes. The store never works this out for itself: the CLI sets it, the
   * server leaves it null, so moves you make in the browser are never
   * attributed to a model.
   */
  model;
  /**
   * The Claude Code session this process runs in, so a claim can note where
   * in its transcript the run begins. Set by the CLI, like `model`.
   */
  session;
  constructor(root, options = {}) {
    this.root = root;
    this.paths = pathsFor(root);
    this.model = options.model ?? null;
    this.session = options.session ?? null;
  }
  /**
   * Close the running slice of the transcript, and copy its entries into
   * .ticketrail/sessions/ so the run can still be read once Claude Code has
   * cleaned the transcript up. Saving is best effort: a run that could not be
   * saved is still readable from the transcript while that exists.
   */
  endSession(task) {
    const session = task.session;
    if (!session) return;
    if (session.to === null) {
      const size = sizeOf(session.transcript);
      session.to = size === null ? session.from : Math.max(session.from, size);
    }
    if (session.saved || this.config().keepSessions === false) return;
    if (!isTranscriptPath(session.transcript, claudeHome())) return;
    try {
      const reader = new SessionReader(session.transcript, session.from, this.root);
      const kept = lastEntries(reader.read(session.to), MAX_SAVED_ENTRIES);
      const saved = {
        run: session.run,
        startedAt: session.startedAt,
        endedAt: now(),
        mode: task.mode,
        model: task.model,
        clipped: reader.clipped || kept.cut,
        entries: kept.entries
      };
      const file = this.sessionFile(task.id, session.run);
      fs5.mkdirSync(path6.dirname(file), { recursive: true });
      writeJsonAtomic(file, saved);
      session.saved = true;
    } catch {
    }
  }
  /** Where a run's saved session lives. */
  sessionFile(taskId, run2) {
    if (!RUN_ID.test(run2) || !/^[A-Za-z0-9_-]+$/.test(taskId)) throw refuse(400, `"${run2}" is not a run id`);
    return path6.join(this.paths.sessions, taskId, `${run2}.json`);
  }
  /** A run's saved session, or null when it was never saved or has been removed. */
  savedSession(taskId, run2) {
    const saved = readJson(this.sessionFile(taskId, run2));
    return saved && Array.isArray(saved.entries) ? saved : null;
  }
  /**
   * Forget a card's sessions: the current one, its history, and every saved
   * copy. The transcripts themselves are Claude Code's and stay where they are.
   * A run still being written is refused -- it would only come back.
   */
  clearSession(id) {
    const task = this.update(id, (t) => {
      if (t.session && t.session.to === null && (t.column === "in-progress" || t.column === "user-input")) {
        throw refuse(409, "Claude is still working on this card. Clear its session once the run has finished.");
      }
      if (!t.session && !t.sessionHistory.length) return false;
      t.session = null;
      t.sessionHistory = [];
      t.activity.push({ at: now(), kind: "info", text: "Session cleared." });
    });
    fs5.rmSync(path6.join(this.paths.sessions, task.id), { recursive: true, force: true });
    return task;
  }
  /**
   * A new run begins: the session so far becomes history, saved if it was
   * not already, and the oldest saved copies beyond the cap are deleted.
   */
  retireSession(task) {
    const session = task.session;
    if (!session) return;
    this.endSession(task);
    if (session.saved) {
      const past = {
        run: session.run,
        startedAt: session.startedAt,
        // finishedAt is cleared when a card is queued again; the saved copy knows when the run ended
        endedAt: this.savedSession(task.id, session.run)?.endedAt ?? task.finishedAt ?? now(),
        mode: task.mode
      };
      const history = [...task.sessionHistory.filter((h) => h.run !== session.run), past];
      for (const dropped of history.slice(0, Math.max(0, history.length - MAX_SESSION_HISTORY))) {
        fs5.rmSync(this.sessionFile(task.id, dropped.run), { force: true });
      }
      task.sessionHistory = history.slice(-MAX_SESSION_HISTORY);
    }
    task.session = null;
  }
  /** A status entry, carrying the model when one is known. */
  status(text, kind = "status") {
    return { at: now(), kind, text, ...this.model ? { model: this.model } : {} };
  }
  // ---------------------------------------------------------------- setup
  static init(root, overrides = {}) {
    const store = new _Store(root);
    fs5.mkdirSync(store.paths.tasks, { recursive: true });
    fs5.mkdirSync(store.paths.files, { recursive: true });
    fs5.mkdirSync(store.paths.locks, { recursive: true });
    fs5.mkdirSync(store.paths.runtime, { recursive: true });
    if (!fs5.existsSync(store.paths.config)) {
      writeJsonAtomic(store.paths.config, { ...DEFAULT_CONFIG, ...overrides });
    } else if (Object.keys(overrides).length) {
      store.saveConfig({ ...store.config(), ...overrides });
    }
    return store;
  }
  /**
   * What to call this board. An explicit title in config.json wins; otherwise
   * fall back to the package name and then to the directory, so a board always
   * identifies the project it belongs to without being configured.
   */
  projectName() {
    const configured = this.config().title.trim();
    if (configured && configured !== DEFAULT_CONFIG.title) return configured;
    try {
      const pkg = JSON.parse(fs5.readFileSync(path6.join(this.root, "package.json"), "utf8"));
      if (typeof pkg?.name === "string" && pkg.name.trim()) return pkg.name.trim();
    } catch {
    }
    return path6.basename(this.root);
  }
  config() {
    const stored = readJson(this.paths.config) ?? {};
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      // merged rather than replaced, so a config written before this setting
      // existed still gets every field
      notifications: { ...DEFAULT_CONFIG.notifications, ...stored.notifications ?? {} }
    };
  }
  /** Apply a partial settings change and return the whole config. */
  updateSettings(changes) {
    return withLock(this.paths.boardLock, () => {
      const current = this.config();
      const next = {
        ...current,
        ...typeof changes.title === "string" && changes.title.trim() ? { title: changes.title.trim() } : {},
        ...typeof changes.keepSessions === "boolean" ? { keepSessions: changes.keepSessions } : {},
        notifications: { ...current.notifications, ...changes.notifications ?? {} }
      };
      this.saveConfig(next);
      return next;
    });
  }
  saveConfig(config) {
    writeJsonAtomic(this.paths.config, config);
  }
  // ---------------------------------------------------------------- reads
  taskFile(id) {
    return path6.join(this.paths.tasks, `${id}.json`);
  }
  /** All tasks, board order: column order first, then the fractional key. */
  list(options = {}) {
    let names;
    try {
      names = fs5.readdirSync(this.paths.tasks);
    } catch {
      return [];
    }
    const tasks = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const raw = readJson(path6.join(this.paths.tasks, name));
      if (!raw) continue;
      const task = normalizeTask(raw, name.slice(0, -5));
      if (task.archived && !options.includeArchived) continue;
      tasks.push(task);
    }
    return tasks.sort((a, b) => {
      const ca = COLUMNS.indexOf(a.column);
      const cb = COLUMNS.indexOf(b.column);
      if (ca !== cb) return ca - cb;
      if (a.order !== b.order) return a.order < b.order ? -1 : 1;
      return a.number - b.number;
    });
  }
  get(id) {
    const raw = readJson(this.taskFile(id));
    return raw ? normalizeTask(raw, id) : null;
  }
  column(column) {
    return this.list().filter((t) => t.column === column);
  }
  /** The board's folders, in display order. None at all is the normal case. */
  folders() {
    return normalizeFolders(readJson(this.paths.folders));
  }
  /** A folder by id or by name (case-insensitive). */
  findFolder(ref) {
    const folders = this.folders();
    const name = ref.trim().toLowerCase();
    return folders.find((f) => f.id === ref) ?? folders.find((f) => f.name.toLowerCase() === name) ?? null;
  }
  /** A card by id or by number ("12" or "#12"), archived ones included. */
  find(ref) {
    const direct = this.get(ref);
    if (direct) return direct;
    const number = ref.replace(/^#/, "");
    return this.list({ includeArchived: true }).find((t) => String(t.number) === number) ?? null;
  }
  /**
   * The cards Claude should read alongside this one: its own links, then the
   * investigation it was derived from. Cards that no longer exist are skipped.
   */
  relatedOf(task) {
    const ids = [...task.related];
    if (task.derivedFrom && !ids.includes(task.derivedFrom)) ids.push(task.derivedFrom);
    return ids.map((id) => this.get(id)).filter((t) => t !== null);
  }
  /** Cards that link this one. Shown to the user, never pushed to Claude. */
  referencedBy(id) {
    return this.list({ includeArchived: true }).filter((t) => t.related.includes(id));
  }
  // --------------------------------------------------------------- writes
  save(task) {
    task.updatedAt = now();
    writeJsonAtomic(this.taskFile(task.id), task);
    return task;
  }
  /** Run a mutation with the board lock held. Return false from `fn` to abort. */
  update(id, fn) {
    return withLock(this.paths.boardLock, () => {
      const task = this.get(id);
      if (!task) throw new Error(`No task with id "${id}"`);
      if (fn(task) === false) return task;
      return this.save(task);
    });
  }
  create(input) {
    return withLock(this.paths.boardLock, () => {
      const folder = input.folder ? this.requireFolder(input.folder).id : null;
      const column = input.column ?? "backlog";
      const existing3 = this.list({ includeArchived: true });
      const keys = existing3.filter((t) => t.column === column).map((t) => t.order);
      const number = existing3.reduce((max, t) => Math.max(max, t.number), 0) + 1;
      const timestamp = now();
      const id = makeId();
      const known = new Set(existing3.map((t) => t.id));
      const task = {
        id,
        number,
        title: input.title.trim() || "Untitled",
        description: input.description ?? "",
        column,
        order: input.position === "bottom" ? orderLast(keys) : orderFirst(keys),
        type: input.type ?? null,
        derivedFrom: input.derivedFrom ?? null,
        related: normalizeRelated(input.related, id).filter((r) => known.has(r)),
        folder,
        agent: input.agent ? requireAgentName(input.agent) : null,
        worker: input.worker ? requireWorkerName(input.worker) : null,
        claimedBy: null,
        model: null,
        session: null,
        sessionHistory: [],
        mode: null,
        returnColumn: null,
        plan: input.plan ?? null,
        result: null,
        resultHistory: [],
        labels: normalizeLabels(input.labels),
        attachments: [],
        activity: [],
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
        cancelRequested: false,
        archived: false
      };
      return this.save(task);
    });
  }
  /**
   * Apply an edit from the UI. `before`/`after` are the order keys of the
   * neighbours the card was dropped between; omit both to drop it on top.
   */
  patch(id, changes) {
    return this.update(id, (task) => {
      if (task.column === "in-progress") {
        const locked = ["type", "agent", "worker"].filter(
          (key) => changes[key] !== void 0 && changes[key] !== task[key]
        );
        if (locked.length) {
          throw refuse(
            409,
            `Claude is working on this card, so its ${locked.join(", ")} cannot change now. Leave a chat message or add a file instead; Claude reads them at its next check-in.`
          );
        }
      }
      if (typeof changes.title === "string") task.title = changes.title;
      if (typeof changes.description === "string") task.description = changes.description;
      if (changes.plan !== void 0) task.plan = changes.plan;
      if (changes.result !== void 0) task.result = changes.result;
      if (Array.isArray(changes.labels)) task.labels = normalizeLabels(changes.labels);
      if (changes.type !== void 0) task.type = changes.type;
      if (Array.isArray(changes.related)) this.relink(task, changes.related);
      if (changes.folder !== void 0) this.refile(task, changes.folder);
      if (changes.agent !== void 0) this.assign(task, changes.agent);
      if (changes.worker !== void 0) this.route(task, changes.worker);
      const reordering = changes.before !== void 0 || changes.after !== void 0;
      const target = changes.column ?? (reordering ? task.column : null);
      if (!target) return;
      if (target === "implement" && isReadOnlyType(task.type)) {
        throw refuse(
          409,
          `${task.type === "investigation" ? "An" : "A"} ${TYPE_LABELS[task.type]} card never writes code, so it cannot go to Implement. ` + (task.type === "investigation" ? 'Use "Create implementation task" under its plan instead.' : "Move it to Plan and Claude will answer it there.")
        );
      }
      const leaving = task.column;
      const siblings = this.column(target).filter((t) => t.id !== id).map((t) => t.order);
      task.column = target;
      task.order = reordering ? orderBetween(changes.before, changes.after) : orderFirst(siblings);
      if (leaving === target) return;
      if (leaving === "in-progress") task.cancelRequested = true;
      if (target !== "in-progress" && target !== "user-input") this.endSession(task);
      if (target !== "user-input") task.returnColumn = null;
      if (target === "plan" || target === "implement") {
        task.cancelRequested = false;
        task.finishedAt = null;
      }
      task.activity.push({ at: now(), kind: "status", text: `Moved to ${COLUMN_LABELS[target]}.` });
    });
  }
  requireFolder(id) {
    const folder = this.folders().find((f) => f.id === id);
    if (!folder) throw refuse(400, `No folder with id "${id}"`);
    return folder;
  }
  /** Put a card in a folder, or take it out with null. */
  assign(task, agent) {
    const next = agent ? requireAgentName(agent) : null;
    if (next === task.agent) return;
    task.agent = next;
    task.activity.push({
      at: now(),
      kind: "info",
      text: next ? `Assigned to agent ${next}.` : "No longer assigned to an agent."
    });
  }
  route(task, worker) {
    const next = worker ? requireWorkerName(worker) : null;
    if (next === task.worker) return;
    task.worker = next;
    task.activity.push({
      at: now(),
      kind: "info",
      text: next ? `Sent to worker ${next}.` : "Any worker may take it."
    });
  }
  refile(task, folderId) {
    const next = folderId ? this.requireFolder(folderId) : null;
    if ((next?.id ?? null) === task.folder) return;
    task.folder = next?.id ?? null;
    task.activity.push({
      at: now(),
      kind: "info",
      text: next ? `Moved to folder ${next.name}.` : "Removed from its folder."
    });
  }
  // -------------------------------------------------------------- folders
  saveFolders(folders) {
    writeJsonAtomic(this.paths.folders, { version: 1, folders });
  }
  createFolder(input) {
    return withLock(this.paths.boardLock, () => {
      const name = cleanFolderName(input.name);
      if (!name) throw refuse(400, "A folder needs a name.");
      const folders = this.folders();
      if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
        throw refuse(409, `There is already a folder called "${name}".`);
      }
      const folder = {
        id: makeId("d"),
        name,
        // a new folder gets the next colour round, so neighbours rarely match
        color: input.color && isFolderColor(input.color) ? input.color : FOLDER_COLORS[(folders.length + 1) % FOLDER_COLORS.length],
        order: orderLast(folders.map((f) => f.order)),
        createdAt: now()
      };
      this.saveFolders([...folders, folder]);
      return folder;
    });
  }
  /** Rename, recolour, or reorder (between the `before`/`after` keys) a folder. */
  updateFolder(id, changes) {
    return withLock(this.paths.boardLock, () => {
      const folders = this.folders();
      const folder = folders.find((f) => f.id === id);
      if (!folder) throw refuse(404, `No folder with id "${id}"`);
      if (changes.name !== void 0) {
        const name = cleanFolderName(changes.name);
        if (!name) throw refuse(400, "A folder needs a name.");
        if (folders.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
          throw refuse(409, `There is already a folder called "${name}".`);
        }
        folder.name = name;
      }
      if (changes.color !== void 0) {
        if (!isFolderColor(changes.color)) throw refuse(400, `Unknown colour "${changes.color}".`);
        folder.color = changes.color;
      }
      if (changes.before !== void 0 || changes.after !== void 0) {
        folder.order = orderBetween(changes.before, changes.after);
      }
      this.saveFolders(folders);
      return folder;
    });
  }
  /**
   * Remove a folder. Its cards are kept and become unfiled, in the same lock
   * (withLock is not reentrant, so the cards are saved directly).
   */
  deleteFolder(id) {
    return withLock(this.paths.boardLock, () => {
      const folders = this.folders();
      const folder = folders.find((f) => f.id === id);
      if (!folder) throw refuse(404, `No folder with id "${id}"`);
      for (const task of this.list({ includeArchived: true })) {
        if (task.folder !== id) continue;
        task.folder = null;
        task.activity.push({ at: now(), kind: "info", text: `Folder ${folder.name} was deleted.` });
        this.save(task);
      }
      const rest = folders.filter((f) => f.id !== id);
      this.saveFolders(rest);
      return rest;
    });
  }
  /** Replace a card's related links, noting what was linked and unlinked. */
  relink(task, ids) {
    const next = normalizeRelated(ids, task.id).filter((r) => this.get(r) !== null);
    const label = (r) => `#${this.get(r)?.number ?? "?"}`;
    const added = next.filter((r) => !task.related.includes(r));
    const removed = task.related.filter((r) => !next.includes(r));
    task.related = next;
    if (added.length) task.activity.push({ at: now(), kind: "info", text: `Linked ${added.map(label).join(", ")}.` });
    if (removed.length) task.activity.push({ at: now(), kind: "info", text: `Unlinked ${removed.map(label).join(", ")}.` });
  }
  move(id, column, before, after) {
    return this.patch(id, { column, before, after });
  }
  archive(id) {
    return this.update(id, (task) => {
      task.archived = true;
    });
  }
  activity(id, text, kind = "info") {
    return this.update(id, (task) => {
      task.activity.push({ at: now(), kind, text });
    });
  }
  message(id, text, role, needsAnswer = false) {
    let created;
    const task = this.update(id, (t) => {
      created = { id: makeId("m"), at: now(), role, text, ...needsAnswer ? { needsAnswer: true } : {} };
      t.messages.push(created);
      if (role === "user") {
        const question = pendingQuestion(t);
        if (question) {
          question.answeredBy = created.id;
          if (t.column === "user-input") {
            t.column = t.returnColumn ?? "in-progress";
            t.returnColumn = null;
            t.activity.push({ at: now(), kind: "status", text: "Answer received, back to Claude." });
          }
        }
      }
    });
    return { task, message: created };
  }
  /** Park a task on "User Input" with a blocking question. */
  ask(id, question) {
    let created;
    const task = this.update(id, (t) => {
      created = { id: makeId("m"), at: now(), role: "claude", text: question, needsAnswer: true };
      t.messages.push(created);
      if (t.column !== "user-input") {
        t.returnColumn = t.column === "in-progress" ? "in-progress" : t.column;
        t.column = "user-input";
      }
      t.activity.push(this.status("Waiting for your input."));
    });
    return { task, message: created };
  }
  /**
   * Claim the top card of Implement, else Plan. A named worker passes its name,
   * which the card records, and may pass `match` to take only the cards meant
   * for it; the lock means two workers never get the same card.
   */
  claimNext(options = {}) {
    const filter = options.match ?? (() => true);
    const worker = options.worker || null;
    const match = (t) => t.worker ? t.worker === worker : filter(t);
    return withLock(this.paths.boardLock, () => {
      const folders = this.folders();
      for (const column of QUEUE_COLUMNS) {
        const candidates = laneOrder(this.list().filter((t) => t.column === column && match(t)), folders);
        const task = candidates[0];
        if (!task) continue;
        this.retireSession(task);
        task.mode = column === "plan" ? "plan" : "implement";
        task.column = "in-progress";
        task.order = orderFirst(this.column("in-progress").map((t) => t.order));
        task.startedAt = now();
        task.finishedAt = null;
        task.cancelRequested = false;
        task.claimedBy = worker;
        const from = this.session ? sizeOf(this.session.transcript) : null;
        if (this.session && from !== null) {
          task.session = { ...this.session, from, to: null, run: makeId("r"), startedAt: task.startedAt, saved: false };
        }
        const previous = task.model;
        if (this.model) task.model = this.model;
        if (previous && this.model && previous !== this.model) {
          task.activity.push(
            this.status(`Model changed since the last run: ${modelLabel(previous)} \u2192 ${modelLabel(this.model)}.`)
          );
        }
        const who = task.claimedBy ? ` (worker ${task.claimedBy})` : "";
        task.activity.push(
          this.status(task.mode === "plan" ? `Claude started planning${who}.` : `Claude started implementing${who}.`)
        );
        return this.save(task);
      }
      return null;
    });
  }
  /** Finish a planning run: store the plan and park the card for review. */
  savePlan(id, plan) {
    return this.update(id, (task) => {
      task.plan = plan;
      task.mode = "plan";
      task.column = "planned";
      task.order = orderFirst(this.column("planned").filter((t) => t.id !== id).map((t) => t.order));
      task.finishedAt = now();
      this.endSession(task);
      task.activity.push(this.status("Plan ready for review."));
    });
  }
  finish(id, result) {
    return this.update(id, (task) => {
      if (task.result?.trim()) {
        const done = task.activity.findLast((a) => a.kind === "status" && a.text === "Done.");
        task.resultHistory = [...task.resultHistory, { at: done?.at ?? task.updatedAt, text: task.result }].slice(
          -MAX_RESULT_HISTORY
        );
      }
      task.result = result;
      task.column = "done";
      task.order = orderFirst(this.column("done").filter((t) => t.id !== id).map((t) => t.order));
      task.finishedAt = now();
      this.endSession(task);
      task.activity.push(this.status("Done."));
    });
  }
  /**
   * Spawn a Feature card from a finished investigation. The plan is copied
   * across rather than referenced: the worker contract already treats a stored
   * plan as an approved spec, so the new card is actionable immediately.
   *
   * Two locked writes rather than one -- withLock is not reentrant -- which is
   * safe here because the worst interleaving loses only the source card's
   * activity note.
   */
  deriveImplementation(id) {
    const source = this.get(id);
    if (!source) throw new Error(`No task with id "${id}"`);
    if (source.type !== "investigation") {
      throw refuse(409, "Only an Investigation card can spawn an implementation task.");
    }
    if (!source.plan) {
      throw refuse(409, "This investigation has no plan yet, so there is nothing to implement.");
    }
    const created = this.create({
      title: source.title,
      description: `Implements the findings of #${source.number}.`,
      plan: source.plan,
      labels: source.labels,
      type: "feature",
      derivedFrom: source.id,
      column: "implement"
    });
    this.activity(source.id, `Spawned #${created.number} to implement this.`, "status");
    return this.update(created.id, (task) => {
      task.activity.push({ at: now(), kind: "status", text: `Derived from #${source.number}.` });
    });
  }
  fail(id, reason) {
    const { task } = this.message(id, `I hit a problem and stopped:

${reason}`, "claude", true);
    return this.update(task.id, (t) => {
      t.returnColumn = t.mode === "plan" ? "plan" : "implement";
      t.column = "user-input";
      this.endSession(t);
      t.activity.push(this.status(reason, "error"));
    });
  }
  // ------------------------------------------------------------ attachments
  filePath(attachment) {
    return path6.join(this.paths.files, typeof attachment === "string" ? attachment : attachment.id);
  }
  /**
   * Record a file that has already been written into .ticketrail/files/.
   * The bytes land on disk first so a large upload never holds the board lock.
   */
  record(taskId, attachment) {
    return this.update(taskId, (task) => {
      task.attachments.push(attachment);
      task.activity.push({
        at: now(),
        kind: "file",
        text: `${attachment.addedBy === "claude" ? "Claude attached" : "Attached"} ${attachment.name}`
      });
    });
  }
  /** Allocate the on-disk name for a new attachment, extension included. */
  newAttachmentId(name, mime) {
    const ext = safeExtension(name, mime);
    return makeId("f") + (ext ? `.${ext}` : "");
  }
  /** Attach bytes already in memory (the CLI reading a file from disk). */
  attach(taskId, input) {
    if (!this.get(taskId)) throw new Error(`No task with id "${taskId}"`);
    const id = this.newAttachmentId(input.name, input.mime);
    fs5.mkdirSync(this.paths.files, { recursive: true });
    fs5.writeFileSync(path6.join(this.paths.files, id), input.data);
    return this.finishAttachment(taskId, {
      id,
      name: displayName(input.name, id),
      mime: input.mime,
      size: input.data.length,
      addedAt: now(),
      addedBy: input.addedBy ?? "claude"
    });
  }
  /**
   * Register a file the server streamed straight to disk. If recording it
   * fails the orphaned bytes are removed, so files/ never accumulates junk.
   */
  finishAttachment(taskId, attachment) {
    try {
      return { task: this.record(taskId, attachment), attachment };
    } catch (err) {
      try {
        fs5.rmSync(this.filePath(attachment), { force: true });
      } catch {
      }
      throw err;
    }
  }
  detach(taskId, attachmentId) {
    const task = this.update(taskId, (t) => {
      const found = t.attachments.find((a) => a.id === attachmentId);
      if (!found) return false;
      t.attachments = t.attachments.filter((a) => a.id !== attachmentId);
      t.activity.push({ at: now(), kind: "file", text: `Removed ${found.name}` });
    });
    try {
      fs5.rmSync(path6.join(this.paths.files, attachmentId), { force: true });
    } catch {
    }
    return task;
  }
  setMode(id, mode) {
    return this.update(id, (task) => {
      task.mode = mode;
    });
  }
};

// src/cli/args.ts
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const set = (name, value) => {
    const current = flags[name];
    if (current === void 0) return void (flags[name] = value);
    if (typeof value !== "string") return;
    flags[name] = typeof current === "string" ? [current, value] : Array.isArray(current) ? [...current, value] : value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== void 0 && !next.startsWith("--")) {
      set(body, next);
      i++;
    } else {
      set(body, true);
    }
  }
  return { positional, flags };
}
function flagString(args, ...names) {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.length) return value[value.length - 1];
  }
  return void 0;
}
function flagList(args, ...names) {
  const out = [];
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) out.push(...value);
  }
  return out;
}
function flagBool(args, ...names) {
  return names.some((name) => args.flags[name] === true || args.flags[name] === "true");
}
function flagNumber(args, name, fallback) {
  const value = flagString(args, name);
  const parsed = value === void 0 ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// src/core/board-init.ts
import fs8 from "fs";
import path9 from "path";
import { fileURLToPath } from "url";

// src/core/registry.ts
import crypto from "crypto";
import fs7 from "fs";
import os2 from "os";
import path8 from "path";

// src/core/presence.ts
import fs6 from "fs";
import path7 from "path";
var HEARTBEAT_MS = 15e3;
var STALE_MS2 = 45e3;
var LAST_SEEN = "last-seen";
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function startHeartbeat(store, who = {}) {
  const dir = store.paths.workers;
  const file = path7.join(dir, `${process.pid}.json`);
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const name = who.name || null;
  const filter = who.filter || null;
  const beat = () => {
    try {
      fs6.mkdirSync(dir, { recursive: true });
      const seenAt = (/* @__PURE__ */ new Date()).toISOString();
      fs6.writeFileSync(file, JSON.stringify({ pid: process.pid, name, filter, startedAt, seenAt, state: "waiting" }));
    } catch {
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.off("exit", stop);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    fs6.rmSync(file, { force: true });
  };
  const onSignal = (signal) => {
    stop();
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
  };
  process.once("exit", stop);
  for (const signal of SIGNALS) process.once(signal, onSignal);
  return stop;
}
var SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function touchWorker(store) {
  try {
    fs6.mkdirSync(store.paths.workers, { recursive: true });
    fs6.writeFileSync(path7.join(store.paths.workers, LAST_SEEN), (/* @__PURE__ */ new Date()).toISOString());
  } catch {
  }
}
function workerPresence(store, now2 = Date.now()) {
  const dir = store.paths.workers;
  let entries;
  try {
    entries = fs6.readdirSync(dir);
  } catch {
    return { waiting: 0, lastSeen: null, workers: [] };
  }
  const workers = [];
  let latest = 0;
  for (const name of entries) {
    const file = path7.join(dir, name);
    try {
      if (name === LAST_SEEN) {
        const at2 = Date.parse(fs6.readFileSync(file, "utf8").trim());
        if (Number.isFinite(at2)) latest = Math.max(latest, at2);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const beat = JSON.parse(fs6.readFileSync(file, "utf8"));
      const at = Date.parse(beat.seenAt);
      if (!Number.isFinite(at) || now2 - at > STALE_MS2 || !alive(beat.pid)) {
        fs6.rmSync(file, { force: true });
        continue;
      }
      workers.push({
        pid: beat.pid,
        name: typeof beat.name === "string" && beat.name ? beat.name : null,
        filter: typeof beat.filter === "string" && beat.filter ? beat.filter : null,
        since: typeof beat.startedAt === "string" ? beat.startedAt : beat.seenAt
      });
      latest = Math.max(latest, at);
    } catch {
    }
  }
  workers.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.pid - b.pid);
  return { waiting: workers.length, lastSeen: latest ? new Date(latest).toISOString() : null, workers };
}

// src/core/registry.ts
function registryHome() {
  return envVar("HOME") ?? path8.join(os2.homedir(), ".ticketrail");
}
function registryFile() {
  const file = path8.join(registryHome(), "projects.json");
  const legacy = path8.join(os2.homedir(), ".promptkanban", "projects.json");
  if (!envVar("HOME") && !fs7.existsSync(file) && fs7.existsSync(legacy)) {
    fs7.mkdirSync(path8.dirname(file), { recursive: true });
    fs7.copyFileSync(legacy, file);
  }
  return file;
}
function canonical(root) {
  const absolute = path8.resolve(root);
  try {
    return fs7.realpathSync(absolute);
  } catch {
    return absolute;
  }
}
function projectId(root) {
  return crypto.createHash("sha256").update(canonical(root)).digest("hex").slice(0, 8);
}
function isBoard(root) {
  return hasBoard(root);
}
function shortenPath(root) {
  const home = os2.homedir();
  return root.startsWith(home) ? root.replace(home, "~") : root;
}
function readRecords() {
  let raw;
  try {
    raw = JSON.parse(fs7.readFileSync(registryFile(), "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(raw?.projects) ? raw.projects : [];
  const seen = /* @__PURE__ */ new Set();
  const records = [];
  for (const entry of list) {
    if (typeof entry?.path !== "string") continue;
    const id = projectId(entry.path);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      path: path8.resolve(entry.path),
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  return records;
}
function writeRecords(records) {
  const home = registryHome();
  fs7.mkdirSync(home, { recursive: true });
  const file = registryFile();
  const tmp = path8.join(home, `.tmp-projects-${process.pid}-${Date.now()}.json`);
  fs7.writeFileSync(tmp, JSON.stringify({ projects: records }, null, 2) + "\n", "utf8");
  fs7.renameSync(tmp, file);
}
function lockPath() {
  return path8.join(registryHome(), ".registry.lock");
}
function listProjects() {
  return readRecords().sort((a, b) => path8.basename(a.path).localeCompare(path8.basename(b.path)));
}
function findProject(idOrPath) {
  const records = readRecords();
  return records.find((r) => r.id === idOrPath) ?? records.find((r) => r.id === projectId(idOrPath)) ?? null;
}
function addProject(root) {
  const resolved = path8.resolve(root);
  return withLock(lockPath(), () => {
    const records = readRecords();
    const existing3 = records.find((r) => r.id === projectId(resolved));
    if (existing3) return existing3;
    const record = {
      id: projectId(resolved),
      path: resolved,
      addedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeRecords([...records, record]);
    return record;
  });
}
function removeProject(idOrPath) {
  return withLock(lockPath(), () => {
    const records = readRecords();
    const target = records.find((r) => r.id === idOrPath) ?? records.find((r) => r.id === projectId(idOrPath));
    if (!target) return null;
    writeRecords(records.filter((r) => r.id !== target.id));
    return target;
  });
}
var QUEUE = ["plan", "implement"];
function describeProject(record) {
  const base = {
    ...record,
    shortPath: shortenPath(record.path),
    summary: { queued: 0, inProgress: 0, blocked: 0, done: 0, total: 0 }
  };
  if (!isBoard(record.path)) {
    return { ...base, name: path8.basename(record.path), missing: true };
  }
  const store = new Store(record.path);
  const tasks = store.list();
  return {
    ...base,
    name: store.projectName(),
    missing: false,
    summary: {
      queued: tasks.filter((t) => QUEUE.includes(t.column)).length,
      inProgress: tasks.filter((t) => t.column === "in-progress").length,
      blocked: tasks.filter((t) => pendingQuestion(t)).length,
      done: tasks.filter((t) => t.column === "done").length,
      total: tasks.length
    },
    workers: workerPresence(store)
  };
}
function describeProjects() {
  return listProjects().map(describeProject);
}

// src/core/board-init.ts
function templateRoot() {
  const here = path9.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path9.join(here, "..", "templates", "claude"),
    // dist/cli.js
    path9.join(here, "..", "..", "templates", "claude"),
    // src/core/*.ts
    path9.join(here, "..", "..", "..", "templates", "claude")
    // src/cli/commands/*.ts
  ];
  for (const dir of candidates) {
    if (fs8.existsSync(path9.join(dir, "skills"))) return path9.resolve(dir);
  }
  return null;
}
function cliCommand() {
  const here = fileURLToPath(import.meta.url);
  if (here.includes(`${path9.sep}node_modules${path9.sep}`)) return "npx ticketrail";
  const bundle = path9.join(path9.dirname(here), "cli.js");
  return fs8.existsSync(bundle) ? `node ${bundle}` : "npx ticketrail";
}
function copyTree(from, to, force, written, root) {
  fs8.mkdirSync(to, { recursive: true });
  for (const entry of fs8.readdirSync(from, { withFileTypes: true })) {
    const src = path9.join(from, entry.name);
    const dest = path9.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, force, written, root);
    } else if (force || !fs8.existsSync(dest)) {
      const body = fs8.readFileSync(src, "utf8").replaceAll("{{pk}}", cliCommand());
      fs8.writeFileSync(dest, body);
      written.push(path9.relative(root, dest));
    }
  }
}
function patchGitignore(root) {
  const file = path9.join(root, ".gitignore");
  const dir = dataDirName(root);
  const entries = [`${dir}/.locks/`, `${dir}/.runtime/`, `${dir}/sessions/`];
  const current = fs8.existsSync(file) ? fs8.readFileSync(file, "utf8") : "";
  const missing = entries.filter((e) => !current.split(/\r?\n/).includes(e));
  if (!missing.length) return;
  const block = `${current.trim() ? current.replace(/\s*$/, "\n\n") : ""}# Ticketrail runtime state (the board itself is committed)
${missing.join("\n")}
`;
  fs8.writeFileSync(file, block);
}
function initBoard(root, options = {}) {
  const resolved = path9.resolve(root);
  const force = options.force ?? false;
  const fresh = !hasBoard(resolved);
  const store = Store.init(resolved, { port: options.port ?? DEFAULT_CONFIG.port });
  if (options.title || fresh) {
    store.saveConfig({ ...store.config(), title: options.title ?? store.projectName() });
  }
  const written = [];
  const templates = templateRoot();
  if (templates) copyTree(templates, path9.join(resolved, ".claude"), force, written, resolved);
  patchGitignore(resolved);
  addProject(resolved);
  if (fresh && store.list().length === 0) {
    store.create({
      title: "Welcome to Ticketrail",
      description: [
        "This card is a tour. Cards you write here are what Claude Code works from.",
        "",
        "- Write cards in **Backlog**. Only you put things there.",
        "- Drag a card to **Plan** and Claude researches it and writes a plan back.",
        "- Review the plan in **Planned**, edit it, then drag to **Implement**.",
        "- Drag straight to **Implement** to skip planning.",
        "- If Claude needs something from you the card lands in **User Input** \u2014 answer it right here in the card.",
        "",
        "Start the worker with `/ticketrail-work` in a Claude Code session, then drag this card to Plan to see it move."
      ].join("\n")
    });
  }
  return { root: resolved, name: store.projectName(), fresh, written, templatesMissing: !templates };
}

// src/cli/commands/init.ts
function initCommand(args) {
  const result = initBoard(process.cwd(), {
    port: flagNumber(args, "port", DEFAULT_CONFIG.port),
    title: flagString(args, "title"),
    force: flagBool(args, "force")
  });
  const dir = dataDirName(result.root);
  console.log(`Ticketrail ready in ${result.root}`);
  console.log(`  project      ${result.name}  (rename it in ${dir}/config.json)`);
  console.log(`  board data   ${dir}/`);
  if (dir === LEGACY_DATA_DIR) {
    console.log(`               made before the rename; stop the server, then: git mv ${LEGACY_DATA_DIR} .ticketrail`);
  }
  if (result.written.length) {
    console.log(`  claude files ${result.written.join("\n               ")}`);
  } else if (!result.templatesMissing) {
    console.log(`  claude files already present (use --force to overwrite)`);
  }
  console.log(`
Next: ticketrail serve   (or /ticketrail-start in Claude Code)`);
}

// src/cli/commands/serve.ts
import { spawn as spawn3 } from "child_process";

// src/server/server.ts
import http from "http";
import fs15 from "fs";
import os5 from "os";
import path16 from "path";

// src/server/folder-dialog.ts
import { spawn } from "child_process";
import os3 from "os";
var TIMEOUT_MS = 5 * 6e4;
function attempts() {
  const prompt = "Choose a project folder for Ticketrail";
  if (process.platform === "darwin") {
    return [
      {
        command: "osascript",
        args: [
          "-e",
          'tell application "System Events" to activate',
          "-e",
          `POSIX path of (choose folder with prompt "${prompt}")`
        ]
      }
    ];
  }
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = '${prompt}'`,
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }"
    ].join("; ");
    return [{ command: "powershell", args: ["-NoProfile", "-STA", "-Command", script] }];
  }
  return [
    { command: "zenity", args: ["--file-selection", "--directory", `--title=${prompt}`] },
    { command: "kdialog", args: ["--getexistingdirectory", os3.homedir()] }
  ];
}
var MissingDialogTool = class extends Error {
};
function run({ command, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve(null);
    }, TIMEOUT_MS);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (chunk) => out += chunk);
    child.stderr.on("data", (chunk) => err += chunk);
    child.on("error", (error) => {
      const missing = error.code === "ENOENT";
      finish(() => reject(missing ? new MissingDialogTool(command) : error));
    });
    child.on("close", (code) => {
      finish(() => {
        const picked = out.trim();
        if (picked) return resolve(picked.replace(/\/+$/, ""));
        if (code === 0) return resolve(null);
        if (/cancel/i.test(err)) return resolve(null);
        resolve(null);
      });
    });
  });
}
var inFlight = null;
async function open() {
  const tried = [];
  for (const attempt of attempts()) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!(error instanceof MissingDialogTool)) throw error;
      tried.push(attempt.command);
    }
  }
  throw new Error(
    `No folder picker is available on this machine (looked for ${tried.join(", ")}). Type the path instead.`
  );
}
function chooseFolder() {
  if (inFlight) return inFlight;
  inFlight = open().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// src/core/watch.ts
import { EventEmitter } from "events";
import path10 from "path";
import chokidar from "chokidar";
var BoardWatcher = class extends EventEmitter {
  watcher = null;
  /** folders.json sits beside tasks/, so it gets a shallow watcher of its own. */
  dataWatcher = null;
  store;
  started = false;
  constructor(store) {
    super();
    this.store = store;
    this.setMaxListeners(0);
  }
  start() {
    if (this.started) return this;
    this.started = true;
    this.watcher = chokidar.watch(this.store.paths.tasks, {
      ignoreInitial: true,
      ignored: (file) => path10.basename(file).startsWith("."),
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 }
    });
    this.watcher.on("add", (file) => this.emitFor("created", file)).on("change", (file) => this.emitFor("updated", file)).on("unlink", (file) => {
      const id = path10.basename(file, ".json");
      this.emit("board", { type: "deleted", id });
    });
    const data = path10.resolve(this.store.paths.data);
    this.dataWatcher = chokidar.watch(data, {
      ignoreInitial: true,
      depth: 0,
      // .ticketrail is itself a dot-directory: skip the dotfiles inside it, not the root
      ignored: (file) => path10.resolve(file) !== data && path10.basename(file).startsWith("."),
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 }
    });
    const foldersChanged = (file) => {
      if (path10.resolve(file) !== path10.resolve(this.store.paths.folders)) return;
      this.emit("board", { type: "folders", folders: this.store.folders() });
    };
    this.dataWatcher.on("add", foldersChanged).on("change", foldersChanged).on("unlink", foldersChanged);
    return this;
  }
  emitFor(type, file) {
    if (!file.endsWith(".json")) return;
    const id = path10.basename(file, ".json");
    const task = this.store.get(id);
    if (!task) return;
    this.emit("board", { type, id, task });
  }
  async stop() {
    this.started = false;
    await Promise.all([this.watcher?.close(), this.dataWatcher?.close()]);
    this.watcher = null;
    this.dataWatcher = null;
  }
};
function waitFor(store, probe, timeoutMs2) {
  const immediate = probe();
  if (immediate) return Promise.resolve(immediate);
  if (timeoutMs2 <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const watcher = new BoardWatcher(store).start();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      void watcher.stop();
      resolve(value);
    };
    const check = () => {
      if (settled) return;
      let value = null;
      try {
        value = probe();
      } catch {
        value = null;
      }
      if (value) finish(value);
    };
    watcher.on("board", check);
    const poll = setInterval(check, 2e3);
    const timer = Number.isFinite(timeoutMs2) ? setTimeout(() => finish(null), timeoutMs2) : null;
  });
}

// src/core/agents.ts
import fs10 from "fs";
import path12 from "path";

// src/core/skills.ts
import crypto2 from "crypto";
import fs9 from "fs";
import path11 from "path";
var SKILL_FILE = "SKILL.md";
function skillsDir(root) {
  return path11.join(root, ".claude", "skills");
}
function skillVersion(raw) {
  return crypto2.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}
function locate(root, name) {
  if (!isSkillName(name)) {
    throw refuse(400, `"${name}" is not a valid skill name: use lowercase letters, digits and single hyphens, at most 64 characters`);
  }
  const base = skillsDir(root);
  const dir = path11.join(base, name);
  const isLink = (file) => {
    try {
      return fs9.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  };
  return { dir, linked: isLink(dir) || isLink(path11.join(dir, SKILL_FILE)) };
}
function existing(root, name) {
  const found = locate(root, name);
  if (!fs9.existsSync(path11.join(found.dir, SKILL_FILE))) throw refuse(404, `No skill named "${name}"`);
  return found;
}
function writable(root, name) {
  const { dir, linked } = existing(root, name);
  if (linked) throw refuse(403, `"${name}" is a symlink to somewhere else; edit it where it lives`);
  return dir;
}
function listFiles(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = fs9.readdirSync(path11.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (rel !== SKILL_FILE) out.push(rel);
    if (out.length >= 200) break;
  }
  return out.sort();
}
function summarize(name, dir, linked, raw) {
  const file = path11.join(dir, SKILL_FILE);
  const { frontmatter, body, valid } = parseFrontmatter(raw);
  return {
    name,
    description: frontmatter.description ?? "",
    managed: MANAGED_SKILLS.includes(name),
    readonly: linked,
    files: listFiles(dir),
    updatedAt: fs9.statSync(file).mtime.toISOString(),
    raw,
    frontmatter,
    frontmatterValid: valid,
    body,
    version: skillVersion(raw),
    path: file
  };
}
function listSkills(root) {
  let entries;
  try {
    entries = fs9.readdirSync(skillsDir(root));
  } catch {
    return [];
  }
  const skills = [];
  for (const name of entries.sort()) {
    if (!isSkillName(name)) continue;
    try {
      const { raw, frontmatter, body, frontmatterValid, version, path: _path, ...summary } = readSkill(root, name);
      skills.push(summary);
    } catch {
    }
  }
  return skills;
}
function readSkill(root, name) {
  const { dir, linked } = existing(root, name);
  return summarize(name, dir, linked, fs9.readFileSync(path11.join(dir, SKILL_FILE), "utf8"));
}
function writeAtomic(file, text) {
  const tmp = path11.join(path11.dirname(file), `.tmp-${path11.basename(file)}-${process.pid}-${Date.now()}`);
  fs9.writeFileSync(tmp, text, "utf8");
  fs9.renameSync(tmp, file);
}
function writeSkill(root, name, raw, expectedVersion, force = false) {
  if (typeof raw !== "string") throw refuse(400, "A skill needs its text");
  const dir = writable(root, name);
  const file = path11.join(dir, SKILL_FILE);
  const current = fs9.readFileSync(file, "utf8");
  if (!force && expectedVersion && skillVersion(current) !== expectedVersion) {
    throw refuse(409, `"${name}" changed on disk since you opened it`);
  }
  writeAtomic(file, raw);
  return readSkill(root, name);
}
function titleFor(name) {
  return name.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
function skillTemplate(name, description) {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${titleFor(name)}`,
    "",
    "## When to use",
    "",
    "- Describe the situations where Claude should reach for this skill.",
    "",
    "## Steps",
    "",
    "1. First step.",
    "2. Second step.",
    ""
  ].join("\n");
}
function createSkill(root, input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim().replace(/\s+/g, " ") : "";
  const { dir } = locate(root, name);
  if (!description) throw refuse(400, "A skill needs a description: it is how Claude decides when to use it");
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw refuse(400, `Keep the description under ${MAX_SKILL_DESCRIPTION} characters`);
  }
  if (fs9.existsSync(dir)) throw refuse(409, `A skill named "${name}" already exists`);
  fs9.mkdirSync(dir, { recursive: true });
  const raw = typeof input.raw === "string" && input.raw.trim() ? input.raw : skillTemplate(name, description);
  writeAtomic(path11.join(dir, SKILL_FILE), raw);
  return readSkill(root, name);
}
function deleteSkill(root, name) {
  const dir = writable(root, name);
  if (MANAGED_SKILLS.includes(name)) {
    throw refuse(403, `"${name}" comes with Ticketrail and cannot be deleted; /ticketrail-work depends on it`);
  }
  fs9.rmSync(dir, { recursive: true, force: true });
  return { removed: name };
}
function deleteSkills(root, names) {
  if (!Array.isArray(names) || !names.length) throw refuse(400, "Pick at least one skill to delete");
  const removed = [];
  const failed = [];
  for (const name of new Set(names.map(String))) {
    try {
      deleteSkill(root, name);
      removed.push(name);
    } catch (err) {
      failed.push({ name, reason: err.message });
    }
  }
  return { removed, failed };
}

// src/core/agent-templates.ts
var AGENT_TEMPLATES = {
  blank: {
    label: "Blank",
    description: "",
    body: "You are a specialist. Describe your role, how you work and what a good result looks like.\n"
  },
  reviewer: {
    label: "Reviewer",
    description: "Reviews code changes for bugs, risky edge cases and unclear code. Use for review cards.",
    body: [
      "You are a careful code reviewer.",
      "",
      "- Read the change (git diff) and the card it belongs to before judging it.",
      "- Look for correctness bugs first, then missing tests, then readability.",
      "- Name each finding with file and line, why it is wrong and how to fix it.",
      "- Do not rewrite working code to taste.",
      ""
    ].join("\n")
  },
  tester: {
    label: "Tester",
    description: "Writes and runs tests for a change and reports what is covered. Use for testing cards.",
    body: [
      "You are a test engineer.",
      "",
      "- Find the project test setup and follow its conventions.",
      "- Cover the behaviour the card describes, including edge cases and failure paths.",
      "- Run the whole suite and report exactly what passed and what failed.",
      ""
    ].join("\n")
  },
  frontend: {
    label: "Frontend developer",
    description: "Builds and polishes UI components, styling and interactions. Use for frontend cards.",
    body: [
      "You are a frontend developer.",
      "",
      "- Match the existing components, styling and naming before adding anything new.",
      "- Keep components small and accessible (labels, keyboard, focus).",
      "- Build the web app and check it renders before you finish.",
      ""
    ].join("\n")
  },
  "docs-writer": {
    label: "Docs writer",
    description: "Writes and updates documentation: README, guides and code comments. Use for docs cards.",
    body: [
      "You are a technical writer.",
      "",
      "- Write for someone who has not seen the code: what it does, how to use it, an example.",
      "- Keep the tone and structure of the existing docs.",
      "- Check every command and path you mention actually exists.",
      ""
    ].join("\n")
  }
};

// src/core/agents.ts
var isAgentName = isSkillName;
function agentsDir(root) {
  return path12.join(root, ".claude", "agents");
}
function locate2(root, name) {
  if (!isAgentName(name)) {
    throw refuse(400, `"${name}" is not a valid agent name: use lowercase letters, digits and single hyphens, at most 64 characters`);
  }
  const file = path12.join(agentsDir(root), `${name}.md`);
  let linked = false;
  try {
    linked = fs10.lstatSync(file).isSymbolicLink();
  } catch {
  }
  return { file, linked };
}
function existing2(root, name) {
  const found = locate2(root, name);
  if (!fs10.existsSync(found.file)) throw refuse(404, `No agent named "${name}"`);
  return found;
}
function writable2(root, name) {
  const { file, linked } = existing2(root, name);
  if (linked) throw refuse(403, `"${name}" is a symlink to somewhere else; edit it where it lives`);
  return file;
}
function agentExists(root, name) {
  return isAgentName(name) && fs10.existsSync(path12.join(agentsDir(root), `${name}.md`));
}
function readAgent(root, name) {
  const { file, linked } = existing2(root, name);
  const raw = fs10.readFileSync(file, "utf8");
  const { frontmatter, body, valid } = parseFrontmatter(raw);
  return {
    name,
    description: frontmatter.description ?? "",
    model: frontmatter.model || null,
    readonly: linked,
    updatedAt: fs10.statSync(file).mtime.toISOString(),
    raw,
    frontmatter,
    frontmatterValid: valid,
    body,
    version: skillVersion(raw),
    path: file
  };
}
function listAgents(root) {
  let entries;
  try {
    entries = fs10.readdirSync(agentsDir(root));
  } catch {
    return [];
  }
  const agents = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!isAgentName(name)) continue;
    try {
      const { raw, frontmatter, body, frontmatterValid, version, path: _path, ...summary } = readAgent(root, name);
      agents.push(summary);
    } catch {
    }
  }
  return agents;
}
function writeAtomic2(file, text) {
  const tmp = path12.join(path12.dirname(file), `.tmp-${path12.basename(file)}-${process.pid}-${Date.now()}`);
  fs10.writeFileSync(tmp, text, "utf8");
  fs10.renameSync(tmp, file);
}
function writeAgent(root, name, raw, expectedVersion, force = false) {
  if (typeof raw !== "string") throw refuse(400, "An agent needs its text");
  const file = writable2(root, name);
  const current = fs10.readFileSync(file, "utf8");
  if (!force && expectedVersion && skillVersion(current) !== expectedVersion) {
    throw refuse(409, `"${name}" changed on disk since you opened it`);
  }
  writeAtomic2(file, raw);
  return readAgent(root, name);
}
function agentTemplate(name, description, template = "blank") {
  const base = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.blank;
  return ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "---", "", base.body].join("\n");
}
function createAgent(root, input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const template = typeof input.template === "string" ? input.template : "blank";
  const fallback = AGENT_TEMPLATES[template]?.description ?? "";
  const description = (typeof input.description === "string" ? input.description.trim().replace(/\s+/g, " ") : "") || fallback;
  const { file } = locate2(root, name);
  if (!description) throw refuse(400, "An agent needs a description: it says what the agent is for");
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw refuse(400, `Keep the description under ${MAX_SKILL_DESCRIPTION} characters`);
  }
  if (fs10.existsSync(file)) throw refuse(409, `An agent named "${name}" already exists`);
  fs10.mkdirSync(path12.dirname(file), { recursive: true });
  const raw = typeof input.raw === "string" && input.raw.trim() ? input.raw : agentTemplate(name, description, template);
  writeAtomic2(file, raw);
  return readAgent(root, name);
}
function deleteAgent(root, name) {
  const file = writable2(root, name);
  fs10.rmSync(file, { force: true });
  return { removed: name };
}

// src/core/skill-import.ts
import { spawn as spawn2 } from "child_process";
import crypto3 from "crypto";
import fs11 from "fs";
import os4 from "os";
import path13 from "path";
var SCAN_TTL_MS = 15 * 6e4;
var CLONE_TIMEOUT_MS = 9e4;
var MAX_SKILLS = 500;
var MAX_SKILL_BYTES = 10 * 1024 * 1024;
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules"]);
var clones = /* @__PURE__ */ new Map();
function parseRepoUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw refuse(400, "Paste the URL of a git repository");
  if (raw.startsWith("-") || /^ext::/i.test(raw) || /\s/.test(raw)) throw refuse(400, `"${raw}" is not a repository URL`);
  const ssh = /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(raw);
  if (ssh) return { repo: raw, ref: null, subdir: null };
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw refuse(400, `"${raw}" is not a repository URL. Use https://\u2026, git@host:owner/repo or file://\u2026`);
  }
  if (!["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol)) {
    throw refuse(400, `${url.protocol.replace(":", "")} URLs are not supported`);
  }
  const page = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:-\/)?(?:tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (page && /^(www\.)?(github\.com|gitlab\.com)$/.test(url.hostname)) {
    const [, owner, name, ref, rest] = page;
    let subdir = rest ? decodeURIComponent(rest).replace(/\/+$/, "") : null;
    if (subdir && path13.posix.basename(subdir) === SKILL_FILE) subdir = path13.posix.dirname(subdir);
    return { repo: `${url.origin}/${owner}/${name}.git`, ref: decodeURIComponent(ref), subdir: subdir || null };
  }
  url.hash = "";
  return { repo: url.toString(), ref: null, subdir: null };
}
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn2("git", args, {
      cwd,
      // never sit waiting for a password prompt nobody can see
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += chunk);
    const timer = setTimeout(() => child.kill("SIGKILL"), CLONE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(refuse(500, err.code === "ENOENT" ? "git is not installed on this machine" : err.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (signal) return reject(refuse(504, "Cloning took too long and was stopped"));
      const reason = stderr.split("\n").map((l) => l.replace(/^(fatal|error|remote): /, "").trim()).filter(Boolean).pop();
      reject(refuse(400, `Could not clone the repository${reason ? `: ${reason}` : ""}`));
    });
  });
}
function findSkillDirs(dir, rel = "", found = []) {
  if (found.length >= MAX_SKILLS) return found;
  let entries;
  try {
    entries = fs11.readdirSync(path13.join(dir, rel), { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) {
    found.push(rel);
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      findSkillDirs(dir, rel ? `${rel}/${entry.name}` : entry.name, found);
    }
  }
  return found;
}
function walkFiles(dir, rel = "") {
  const out = [];
  for (const entry of fs11.readdirSync(path13.join(dir, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}
function skillName(declared, folder) {
  if (isSkillName(declared)) return declared;
  const base = folder ? path13.posix.basename(folder) : "";
  if (isSkillName(base)) return base;
  const slug = String(declared || base).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return isSkillName(slug) ? slug : null;
}
function describe(root, cloneDir, scan) {
  const base = scan.subdir ? path13.resolve(cloneDir, scan.subdir) : cloneDir;
  const inside = base === cloneDir || base.startsWith(cloneDir + path13.sep);
  if (!inside || !fs11.existsSync(base) || !fs11.lstatSync(base).isDirectory()) {
    throw refuse(404, `The repository has no folder "${scan.subdir}"`);
  }
  const prefix = scan.subdir ? `${scan.subdir}/` : "";
  const skills = findSkillDirs(base).map((rel) => {
    const raw = fs11.readFileSync(path13.join(base, rel, SKILL_FILE), "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    const name = skillName(frontmatter.name ?? "", rel || (scan.subdir ?? "") || path13.basename(scan.repo, ".git"));
    return {
      path: (prefix + rel).replace(/\/$/, "") || ".",
      name,
      description: frontmatter.description ?? "",
      files: walkFiles(path13.join(base, rel)).length - 1,
      exists: !!name && fs11.existsSync(path13.join(skillsDir(root), name)),
      duplicateOf: null
    };
  });
  const rank = (p) => [p.split("/").some((part) => part.startsWith(".") && part !== ".") ? 1 : 0, p.split("/").length, p];
  const preferred = /* @__PURE__ */ new Map();
  for (const skill of [...skills].sort((a, b) => compare(rank(a.path), rank(b.path)))) {
    if (!skill.name) continue;
    const first = preferred.get(skill.name);
    if (first) skill.duplicateOf = first.path;
    else preferred.set(skill.name, skill);
  }
  return skills;
}
function compare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}
function forget(id) {
  const clone = clones.get(id);
  if (!clone) return;
  clearTimeout(clone.timer);
  clones.delete(id);
  fs11.rmSync(clone.dir, { recursive: true, force: true });
}
async function scanRepo(root, url) {
  const target = parseRepoUrl(url);
  const dir = fs11.mkdtempSync(path13.join(os4.tmpdir(), "pk-skill-import-"));
  try {
    const args = ["-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (target.ref) args.push("--branch", target.ref);
    await git([...args, "--", target.repo, dir]);
    const id = crypto3.randomBytes(8).toString("hex");
    const head = { id, ...target };
    const scan = { ...head, skills: describe(root, dir, head) };
    const timer = setTimeout(() => forget(id), SCAN_TTL_MS);
    timer.unref?.();
    clones.set(id, { dir, scan, timer });
    return scan;
  } catch (err) {
    fs11.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
function importSkills(root, input) {
  const clone = typeof input.scanId === "string" ? clones.get(input.scanId) : void 0;
  if (!clone) throw refuse(410, "That scan has expired; load the repository again");
  if (!Array.isArray(input.paths) || !input.paths.length) throw refuse(400, "Pick at least one skill to import");
  const overwrite = input.overwrite === true;
  const result = { imported: [], skipped: [] };
  const taken = /* @__PURE__ */ new Set();
  for (const wanted of input.paths) {
    const skill = clone.scan.skills.find((s) => s.path === wanted);
    if (!skill) {
      result.skipped.push({ path: String(wanted), reason: "not in this repository" });
      continue;
    }
    if (!skill.name) {
      result.skipped.push({ path: skill.path, reason: "no usable skill name" });
      continue;
    }
    if (taken.has(skill.name)) {
      result.skipped.push({ path: skill.path, reason: `another selected skill is also called "${skill.name}"` });
      continue;
    }
    const dest = path13.join(skillsDir(root), skill.name);
    let destIsLink = false;
    try {
      destIsLink = fs11.lstatSync(dest).isSymbolicLink();
    } catch {
    }
    if (MANAGED_SKILLS.includes(skill.name)) {
      result.skipped.push({ path: skill.path, reason: `"${skill.name}" comes with Ticketrail and cannot be replaced` });
      continue;
    }
    if (destIsLink) {
      result.skipped.push({ path: skill.path, reason: `"${skill.name}" is a symlink in this project` });
      continue;
    }
    if (fs11.existsSync(dest) && !overwrite) {
      result.skipped.push({ path: skill.path, reason: `"${skill.name}" already exists` });
      continue;
    }
    const source = path13.join(clone.dir, skill.path === "." ? "" : skill.path);
    const files = walkFiles(source);
    const bytes = files.reduce((n, f) => n + fs11.statSync(path13.join(source, f)).size, 0);
    if (bytes > MAX_SKILL_BYTES) {
      result.skipped.push({ path: skill.path, reason: "larger than 10 MB" });
      continue;
    }
    const staging = path13.join(skillsDir(root), `.import-${skill.name}-${process.pid}-${Date.now()}`);
    fs11.mkdirSync(staging, { recursive: true });
    try {
      for (const file of files) {
        fs11.mkdirSync(path13.dirname(path13.join(staging, file)), { recursive: true });
        fs11.copyFileSync(path13.join(source, file), path13.join(staging, file));
      }
      fs11.rmSync(dest, { recursive: true, force: true });
      fs11.renameSync(staging, dest);
    } catch (err) {
      fs11.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    taken.add(skill.name);
    result.imported.push(skill.name);
  }
  return result;
}
function forgetScans() {
  for (const id of [...clones.keys()]) forget(id);
}

// src/server/http.ts
var Router = class {
  routes = [];
  add(method, pattern, handler) {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p, h) {
    return this.add("GET", p, h);
  }
  post(p, h) {
    return this.add("POST", p, h);
  }
  patch(p, h) {
    return this.add("PATCH", p, h);
  }
  put(p, h) {
    return this.add("PUT", p, h);
  }
  delete(p, h) {
    return this.add("DELETE", p, h);
  }
  match(method, pathname) {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
};
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
async function readJsonBody(req, limit = 1e6) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// src/server/sse.ts
var SseHub = class {
  clients = /* @__PURE__ */ new Map();
  heartbeat = null;
  attach(projectId2, res, snapshot2) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(": connected\n\n");
    this.send(res, "snapshot", snapshot2);
    const group = this.clients.get(projectId2) ?? /* @__PURE__ */ new Set();
    group.add(res);
    this.clients.set(projectId2, group);
    res.on("close", () => {
      group.delete(res);
      if (!group.size) this.clients.delete(projectId2);
    });
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const group2 of this.clients.values()) {
          for (const client of group2) client.write(": ping\n\n");
        }
      }, 25e3);
      this.heartbeat.unref?.();
    }
  }
  broadcast(projectId2, event) {
    for (const client of this.clients.get(projectId2) ?? []) this.send(client, "board", event);
  }
  /** Worker presence changed: a worker started or stopped waiting, or checked in. */
  broadcastWorkers(projectId2, presence) {
    for (const client of this.clients.get(projectId2) ?? []) this.send(client, "workers", presence);
  }
  /** Whether anyone is watching this project, so watchers start only when needed. */
  watching(projectId2) {
    return (this.clients.get(projectId2)?.size ?? 0) > 0;
  }
  send(res, event, data) {
    res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  }
  get size() {
    let total = 0;
    for (const group of this.clients.values()) total += group.size;
    return total;
  }
};

// src/server/session.ts
import fs12 from "fs";
var SESSION_ENTRIES = 300;
var POLL_MS = 1e3;
function isLive(task) {
  return Boolean(task.session && task.session.to === null && (task.column === "in-progress" || task.column === "user-input"));
}
function open2(store, id, home) {
  const task = store.get(id);
  if (!task) return { ok: false, status: 404, error: `No task with id "${id}"` };
  const session = task.session;
  if (!session) {
    const snapshot2 = { recorded: false, live: false, entries: [], clipped: false };
    return { ok: true, task, snapshot: snapshot2, reader: null };
  }
  if (!isLive(task) && session.saved) {
    const saved = store.savedSession(task.id, session.run);
    if (saved) {
      const snapshot2 = { recorded: true, live: false, entries: saved.entries, clipped: saved.clipped };
      return { ok: true, task, snapshot: snapshot2, reader: null };
    }
  }
  if (!isTranscriptPath(session.transcript, home)) {
    return { ok: false, status: 403, error: "That transcript is not inside the Claude Code projects folder" };
  }
  const reader = new SessionReader(session.transcript, session.from, store.root);
  const { entries, cut: cut2 } = lastEntries(reader.read(session.to), SESSION_ENTRIES);
  return {
    ok: true,
    task,
    snapshot: { recorded: true, live: isLive(task), entries, clipped: reader.clipped || cut2 },
    reader
  };
}
function sendSavedSession(store, id, run2, res) {
  const task = store.get(id);
  if (!task) return sendJson(res, 404, { error: `No task with id "${id}"` });
  const known = task.sessionHistory.some((h) => h.run === run2) || task.session?.run === run2;
  const saved = known ? store.savedSession(task.id, run2) : null;
  if (!saved) return sendJson(res, 404, { error: "That run has no saved session" });
  const snapshot2 = { recorded: true, live: false, entries: saved.entries, clipped: saved.clipped };
  sendJson(res, 200, snapshot2);
}
function sendSession(store, id, res, home = claudeHome()) {
  const opened = open2(store, id, home);
  if (!opened.ok) return sendJson(res, opened.status, { error: opened.error });
  sendJson(res, 200, opened.snapshot);
}
function streamSession(store, id, res, home = claudeHome()) {
  const opened = open2(store, id, home);
  if (!opened.ok) return sendJson(res, opened.status, { error: opened.error });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const send = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  send("snapshot", opened.snapshot);
  if (!opened.snapshot.live || !opened.reader) {
    send("end", {});
    res.end();
    return;
  }
  const { transcript, from } = opened.task.session;
  const reader = opened.reader;
  let closed = false;
  let watcher = null;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(ping);
    watcher?.close();
  };
  const check = () => {
    if (closed) return;
    const task = store.get(id);
    const same = task?.session?.transcript === transcript && task.session.from === from;
    const to = same ? task.session.to : null;
    const entries = reader.read(to);
    if (entries.length) send("entries", entries);
    if (!task || !same || !isLive(task)) {
      send("end", {});
      stop();
      res.end();
    }
  };
  try {
    watcher = fs12.watch(transcript, () => check());
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }
  const poll = setInterval(check, POLL_MS);
  const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
  poll.unref?.();
  ping.unref?.();
  res.on("close", stop);
}

// src/server/upload.ts
import fs13 from "fs";
import path14 from "path";
async function streamToFile(req, destination) {
  fs13.mkdirSync(path14.dirname(destination), { recursive: true });
  const out = fs13.createWriteStream(destination);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error("That file is too large (limit 25 MB)");
      if (!out.write(chunk)) {
        await new Promise((resolve) => out.once("drain", () => resolve()));
      }
    }
    await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
  } catch (err) {
    out.destroy();
    fs13.rmSync(destination, { force: true });
    throw err;
  }
  if (size === 0) {
    fs13.rmSync(destination, { force: true });
    throw new Error("That file is empty");
  }
  return size;
}

// src/server/static.ts
import fs14 from "fs";
import path15 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};
function resolveWebRoot() {
  const here = path15.dirname(fileURLToPath2(import.meta.url));
  const candidates = [
    path15.join(here, "web"),
    // dist/cli.js -> dist/web
    path15.join(here, "..", "dist", "web"),
    // src/server/*.ts (tsx dev) -> ../../dist/web
    path15.join(here, "..", "..", "dist", "web")
  ];
  for (const dir of candidates) {
    if (fs14.existsSync(path15.join(dir, "index.html"))) return path15.resolve(dir);
  }
  return null;
}
function serveStatic(webRoot, pathname, res) {
  const rel = pathname.replace(/^\/+/, "") || "index.html";
  let file = path15.resolve(webRoot, rel);
  if (!file.startsWith(webRoot) || !fs14.existsSync(file) || fs14.statSync(file).isDirectory()) {
    file = path15.join(webRoot, "index.html");
  }
  if (!fs14.existsSync(file)) return false;
  const ext = path15.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600"
  });
  fs14.createReadStream(file).pipe(res);
  return true;
}

// src/server/server.ts
function snapshot(store) {
  return {
    title: store.projectName(),
    project: {
      id: projectId(store.root),
      name: store.projectName(),
      path: store.root,
      shortPath: shortenPath(store.root)
    },
    settings: store.config().notifications,
    keepSessions: store.config().keepSessions,
    columns: COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id], hint: COLUMN_HINTS[id] })),
    folders: store.folders(),
    tasks: store.list(),
    workers: workerPresence(store)
  };
}
var PRESENCE_POLL_MS = 5e3;
function sameOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function isLoopback(req) {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
async function startServer(store, options = {}) {
  const config = store.config();
  const port = options.port ?? config.port;
  const host = options.host ?? "127.0.0.1";
  const hub = new SseHub();
  const webRoot = resolveWebRoot();
  const defaultId = projectId(store.root);
  const stores = /* @__PURE__ */ new Map([[defaultId, store]]);
  const watchers = /* @__PURE__ */ new Map();
  const presencePolls = /* @__PURE__ */ new Map();
  const storeFor = (id) => {
    const cached = stores.get(id);
    if (cached) return cached;
    const record = findProject(id);
    if (!record || !isBoard(record.path)) return null;
    const resolved = new Store(record.path);
    stores.set(id, resolved);
    return resolved;
  };
  const watch = (id, target) => {
    if (watchers.has(id)) return;
    const watcher = new BoardWatcher(target).start();
    watcher.on("board", (event) => hub.broadcast(id, event));
    watchers.set(id, watcher);
    let last = JSON.stringify(workerPresence(target));
    const poll = setInterval(() => {
      if (!hub.watching(id)) return;
      const presence = workerPresence(target);
      const next = JSON.stringify(presence);
      if (next === last) return;
      last = next;
      hub.broadcastWorkers(id, presence);
    }, PRESENCE_POLL_MS);
    poll.unref?.();
    presencePolls.set(id, poll);
  };
  const router = new Router();
  const board = (handler) => {
    return (ctx) => {
      const resolved = storeFor(ctx.params.pid ?? defaultId);
      if (!resolved) {
        return sendJson(ctx.res, 404, {
          error: `Unknown project "${ctx.params.pid}". Register it with: ticketrail projects add <path>`
        });
      }
      return handler(resolved, ctx);
    };
  };
  router.get(
    "/api/projects",
    ({ res }) => sendJson(res, 200, {
      defaultId,
      projects: describeProjects().map((p) => ({ ...p, isDefault: p.id === defaultId }))
    })
  );
  router.post("/api/projects/browse", async ({ req, res }) => {
    if (!isLoopback(req)) {
      return sendJson(res, 403, {
        error: "The folder picker opens on the machine running the board. Type the path instead."
      });
    }
    const picked = await chooseFolder();
    sendJson(res, 200, picked ? { path: picked } : { cancelled: true });
  });
  router.post("/api/projects", async ({ req, res }) => {
    const body = await readJsonBody(req);
    const raw = typeof body?.path === "string" ? body.path.trim() : "";
    if (!raw) return sendJson(res, 400, { error: "A folder path is required" });
    const root = path16.resolve(raw.startsWith("~") ? raw.replace(/^~/, os5.homedir()) : raw);
    if (!fs15.existsSync(root)) return sendJson(res, 400, { error: `No such folder: ${root}` });
    if (!fs15.statSync(root).isDirectory()) return sendJson(res, 400, { error: `Not a folder: ${root}` });
    const created = !isBoard(root);
    if (created) initBoard(root);
    const record = addProject(root);
    const id = projectId(root);
    stores.delete(id);
    sendJson(res, created ? 201 : 200, {
      created,
      project: { ...describeProject(record), isDefault: id === defaultId }
    });
  });
  router.patch("/api/projects/:pid", async ({ req, res, params }) => {
    const record = findProject(params.pid);
    if (!record) return sendJson(res, 404, { error: `Unknown project "${params.pid}"` });
    if (!isBoard(record.path)) {
      return sendJson(res, 404, { error: "That folder no longer holds a board, so it cannot be renamed." });
    }
    const body = await readJsonBody(req);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return sendJson(res, 400, { error: "A name is required" });
    new Store(record.path).updateSettings({ title });
    sendJson(res, 200, { ...describeProject(record), isDefault: record.id === defaultId });
  });
  router.delete("/api/projects/:pid", async ({ res, params }) => {
    const record = findProject(params.pid);
    if (!record) return sendJson(res, 404, { error: `Unknown project "${params.pid}"` });
    if (record.id === defaultId) {
      return sendJson(res, 409, {
        error: "This is the board the server was started in \u2014 it re-registers itself on every start."
      });
    }
    removeProject(record.id);
    stores.delete(record.id);
    const watcher = watchers.get(record.id);
    if (watcher) {
      await watcher.stop();
      watchers.delete(record.id);
    }
    sendJson(res, 200, { removed: { id: record.id, path: record.path } });
  });
  router.get("/api/projects/:pid/board", board((s, { res }) => sendJson(res, 200, snapshot(s))));
  router.get(
    "/api/projects/:pid/settings",
    board((s, { res }) => {
      const config2 = s.config();
      sendJson(res, 200, { title: config2.title, notifications: config2.notifications, keepSessions: config2.keepSessions });
    })
  );
  router.patch(
    "/api/projects/:pid/settings",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      const flags = ["sound", "desktop", "onStart"];
      const notifications = {};
      for (const flag of flags) {
        if (typeof body?.notifications?.[flag] === "boolean") notifications[flag] = body.notifications[flag];
      }
      const keepSessions = typeof body?.keepSessions === "boolean" ? body.keepSessions : void 0;
      const config2 = s.updateSettings({ title: body.title, notifications, keepSessions });
      sendJson(res, 200, { title: config2.title, notifications: config2.notifications, keepSessions: config2.keepSessions });
    })
  );
  router.get(
    "/api/projects/:pid/events",
    board((s, { res, params }) => {
      const id = params.pid ?? defaultId;
      watch(id, s);
      hub.attach(id, res, snapshot(s));
    })
  );
  router.post(
    "/api/projects/:pid/tasks",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      if (typeof body.title !== "string" || !body.title.trim()) {
        return sendJson(res, 400, { error: "A title is required" });
      }
      sendJson(
        res,
        201,
        s.create({
          title: body.title,
          description: typeof body.description === "string" ? body.description : "",
          column: isColumn(body.column) ? body.column : "backlog",
          position: body.position === "bottom" ? "bottom" : "top",
          type: isTaskType(body.type) ? body.type : null,
          labels: Array.isArray(body.labels) ? body.labels : []
        })
      );
    })
  );
  router.patch(
    "/api/projects/:pid/tasks/:id",
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      if (body.column !== void 0 && !isColumn(body.column)) {
        return sendJson(res, 400, { error: `Unknown column "${body.column}"` });
      }
      if (body.type !== void 0 && body.type !== null && !isTaskType(body.type)) {
        return sendJson(res, 400, { error: `Unknown type "${body.type}". One of: ${TASK_TYPES.join(", ")}` });
      }
      if (body.related !== void 0 && !Array.isArray(body.related)) {
        return sendJson(res, 400, { error: '"related" must be an array of card ids' });
      }
      if (body.folder !== void 0 && body.folder !== null && typeof body.folder !== "string") {
        return sendJson(res, 400, { error: '"folder" must be a folder id or null' });
      }
      if (body.agent !== void 0 && body.agent !== null && typeof body.agent !== "string") {
        return sendJson(res, 400, { error: '"agent" must be an agent name or null' });
      }
      if (body.worker !== void 0 && body.worker !== null && typeof body.worker !== "string") {
        return sendJson(res, 400, { error: '"worker" must be a worker name or null' });
      }
      sendJson(res, 200, s.patch(params.id, body));
    })
  );
  router.get("/api/projects/:pid/tasks/:id/session", board((s, { res, params }) => sendSession(s, params.id, res)));
  router.get(
    "/api/projects/:pid/tasks/:id/session/events",
    board((s, { res, params }) => streamSession(s, params.id, res))
  );
  router.delete(
    "/api/projects/:pid/tasks/:id/session",
    board((s, { res, params }) => sendJson(res, 200, s.clearSession(params.id)))
  );
  router.get(
    "/api/projects/:pid/tasks/:id/sessions/:run",
    board((s, { res, params }) => sendSavedSession(s, params.id, params.run, res))
  );
  router.get("/api/projects/:pid/folders", board((s, { res }) => sendJson(res, 200, s.folders())));
  router.post(
    "/api/projects/:pid/folders",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, s.createFolder({ name: body.name, color: body.color }));
    })
  );
  router.patch(
    "/api/projects/:pid/folders/:fid",
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, s.updateFolder(params.fid, body));
    })
  );
  router.delete(
    "/api/projects/:pid/folders/:fid",
    board((s, { res, params }) => sendJson(res, 200, s.deleteFolder(params.fid)))
  );
  router.get("/api/projects/:pid/skills", board((s, { res }) => sendJson(res, 200, listSkills(s.root))));
  router.post(
    "/api/projects/:pid/skills/import/scan",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, await scanRepo(s.root, body.url));
    })
  );
  router.post(
    "/api/projects/:pid/skills/import",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, importSkills(s.root, body));
    })
  );
  router.post(
    "/api/projects/:pid/skills/delete",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, deleteSkills(s.root, body.names));
    })
  );
  router.get(
    "/api/projects/:pid/skills/:name",
    board((s, { res, params }) => sendJson(res, 200, readSkill(s.root, params.name)))
  );
  router.post(
    "/api/projects/:pid/skills",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, createSkill(s.root, body));
    })
  );
  router.put(
    "/api/projects/:pid/skills/:name",
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, writeSkill(s.root, params.name, body.raw, body.version, body.force === true));
    })
  );
  router.delete(
    "/api/projects/:pid/skills/:name",
    board((s, { res, params }) => sendJson(res, 200, deleteSkill(s.root, params.name)))
  );
  router.get("/api/projects/:pid/agents", board((s, { res }) => sendJson(res, 200, listAgents(s.root))));
  router.get(
    "/api/projects/:pid/agents/:name",
    board((s, { res, params }) => sendJson(res, 200, readAgent(s.root, params.name)))
  );
  router.post(
    "/api/projects/:pid/agents",
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, createAgent(s.root, body));
    })
  );
  router.put(
    "/api/projects/:pid/agents/:name",
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, writeAgent(s.root, params.name, body.raw, body.version, body.force === true));
    })
  );
  router.delete(
    "/api/projects/:pid/agents/:name",
    board((s, { res, params }) => sendJson(res, 200, deleteAgent(s.root, params.name)))
  );
  router.delete(
    "/api/projects/:pid/tasks/:id",
    board((s, { res, params }) => sendJson(res, 200, s.archive(params.id)))
  );
  router.post(
    "/api/projects/:pid/tasks/:id/derive",
    board((s, { res, params }) => sendJson(res, 201, s.deriveImplementation(params.id)))
  );
  router.post(
    "/api/projects/:pid/tasks/:id/messages",
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      if (typeof body.text !== "string" || !body.text.trim()) {
        return sendJson(res, 400, { error: "A message needs text" });
      }
      const { task } = s.message(params.id, body.text.trim(), body.role === "claude" ? "claude" : "user");
      sendJson(res, 201, task);
    })
  );
  router.post(
    "/api/projects/:pid/tasks/:id/attachments",
    board(async (s, { req, res, params }) => {
      if (!s.get(params.id)) return sendJson(res, 404, { error: `No task with id "${params.id}"` });
      const header = req.headers["x-filename"];
      const rawName = typeof header === "string" ? decodeURIComponent(header) : "";
      const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const name = displayName(rawName, "upload");
      const id = s.newAttachmentId(name, mime);
      const size = await streamToFile(req, s.filePath(id));
      const { attachment } = s.finishAttachment(params.id, {
        id,
        name,
        mime,
        size,
        addedAt: (/* @__PURE__ */ new Date()).toISOString(),
        addedBy: "user"
      });
      sendJson(res, 201, attachment);
    })
  );
  router.delete(
    "/api/projects/:pid/tasks/:id/attachments/:fileId",
    board((s, { res, params }) => sendJson(res, 200, s.detach(params.id, params.fileId)))
  );
  router.get(
    "/api/projects/:pid/files/:fileId",
    board((s, { res, url: url2, params }) => {
      const dir = path16.resolve(s.paths.files);
      const file = path16.resolve(dir, params.fileId);
      if (!file.startsWith(dir) || !fs15.existsSync(file)) {
        return sendJson(res, 404, { error: "No such file" });
      }
      const known = s.list().flatMap((t) => t.attachments).find((a) => a.id === params.fileId);
      res.writeHead(200, {
        "content-type": known?.mime ?? mimeForExtension(path16.extname(file)),
        "content-length": fs15.statSync(file).size,
        "cache-control": "private, max-age=31536000, immutable",
        ...url2.searchParams.has("download") && known ? { "content-disposition": `attachment; filename="${known.name.replace(/"/g, "")}"` } : {}
      });
      fs15.createReadStream(file).pipe(res);
    })
  );
  router.get("/api/board", board((s, { res }) => sendJson(res, 200, snapshot(s))));
  router.get(
    "/api/events",
    board((s, { res }) => {
      watch(defaultId, s);
      hub.attach(defaultId, res, snapshot(s));
    })
  );
  const server = http.createServer((req, res) => {
    const url2 = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req.headers.origin, req.headers.host)) {
      return sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
    }
    const route = router.match(method, url2.pathname);
    if (route) {
      const fail = (err) => {
        if (res.headersSent) return res.end();
        const tagged = err.status;
        const missing = /No task with id/.test(err.message);
        sendJson(res, tagged ?? (missing ? 404 : 500), { error: err.message });
      };
      try {
        Promise.resolve(route.handler({ req, res, url: url2, params: route.params })).catch(fail);
      } catch (err) {
        fail(err);
      }
      return;
    }
    if (url2.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
    if (webRoot && method === "GET" && serveStatic(webRoot, url2.pathname, res)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      webRoot ? "Not found" : 'The Ticketrail UI has not been built. Run "npm run build:web" in the ticketrail package.'
    );
  });
  addProject(store.root);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://localhost:${actualPort}`;
  fs15.mkdirSync(store.paths.runtime, { recursive: true });
  fs15.writeFileSync(store.paths.serverInfo, JSON.stringify({ pid: process.pid, port: actualPort, url }, null, 2));
  const close = async () => {
    for (const watcher of watchers.values()) await watcher.stop();
    watchers.clear();
    for (const poll of presencePolls.values()) clearInterval(poll);
    forgetScans();
    presencePolls.clear();
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      const current = JSON.parse(fs15.readFileSync(store.paths.serverInfo, "utf8"));
      if (current.pid === process.pid) fs15.rmSync(store.paths.serverInfo, { force: true });
    } catch {
    }
  };
  return { port: actualPort, url, close };
}

// src/cli/commands/serve.ts
async function serveCommand(store, args) {
  addProject(store.root);
  const handle = await startServer(store, { port: flagNumber(args, "port", store.config().port) });
  const counts = store.list().reduce((acc, task) => {
    acc[task.column] = (acc[task.column] ?? 0) + 1;
    return acc;
  }, {});
  const others = describeProjects().filter((p) => p.path !== store.root && !p.missing);
  console.log(`Ticketrail is serving ${store.projectName()} (${store.root})`);
  console.log(`  ${handle.url}`);
  if (others.length) {
    console.log(`  also switchable from the header: ${others.map((p) => p.name).join(", ")}`);
  }
  console.log(
    `  ${COLUMNS.filter((c) => counts[c]).map((c) => `${COLUMN_LABELS[c]} ${counts[c]}`).join(" \xB7 ") || "board is empty"}`
  );
  if (flagBool(args, "open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn3(opener, [handle.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }
  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// src/cli/commands/board.ts
import fs18 from "fs";

// src/cli/io.ts
import fs16 from "fs";
function readStdin() {
  try {
    return fs16.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function textInput(args, positional, fileFlags = ["file"]) {
  const file = flagString(args, ...fileFlags);
  if (file === "-") return readStdin().trim();
  if (file) return fs16.readFileSync(file, "utf8").trim();
  const text = flagString(args, "text");
  if (text) return text.trim();
  if (positional.length) return positional.join(" ").trim();
  if (!process.stdin.isTTY) return readStdin().trim();
  return "";
}
function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

// src/cli/commands/attach.ts
import fs17 from "fs";
import path17 from "path";
function withPaths(store, task) {
  return {
    ...task,
    attachments: task.attachments.map((a) => ({ ...a, path: store.filePath(a) }))
  };
}
var RELATED_FIELD_LIMIT = 8e3;
function clip(text, id) {
  if (text === null || text.length <= RELATED_FIELD_LIMIT) return text;
  return `${text.slice(0, RELATED_FIELD_LIMIT)}
\u2026(truncated, run show ${id})`;
}
function relatedContext(store, task) {
  return store.relatedOf(task).map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    column: r.column,
    type: r.type,
    labels: r.labels,
    relation: task.related.includes(r.id) ? "related" : "derivedFrom",
    archived: r.archived,
    inProgress: r.column === "in-progress",
    description: clip(r.description, r.id),
    plan: clip(r.plan, r.id),
    result: clip(r.result, r.id),
    attachments: r.attachments.map((a) => ({ ...a, path: store.filePath(a) }))
  }));
}
function attachCommand(store, args, positional) {
  const [id, ...files] = positional;
  if (!id || !files.length) {
    throw new Error("Usage: ticketrail attach <id> <file> [more files...] [--as-user]");
  }
  const added = [];
  for (const file of files) {
    if (!fs17.existsSync(file)) throw new Error(`No such file: ${file}`);
    const stat = fs17.statSync(file);
    if (stat.isDirectory()) throw new Error(`${file} is a directory`);
    const { attachment } = store.attach(id, {
      name: path17.basename(file),
      mime: mimeForExtension(path17.extname(file)),
      data: fs17.readFileSync(file),
      addedBy: flagBool(args, "as-user") ? "user" : "claude"
    });
    added.push(attachment);
    console.log(`attached ${attachment.name} (${formatBytes(attachment.size)}) -> ${attachment.id}`);
  }
}
function filesCommand(store, positional) {
  const [id] = positional;
  const task = id ? store.get(id) : null;
  if (!task) throw new Error("Usage: ticketrail files <id>");
  printJson(withPaths(store, task).attachments);
}
function detachCommand(store, positional) {
  const [id, fileId] = positional;
  if (!id || !fileId) throw new Error("Usage: ticketrail detach <id> <fileId>");
  store.detach(id, fileId);
  console.log(`removed ${fileId}`);
}

// src/cli/commands/board.ts
function addCommand(store, args, positional) {
  const title = positional.join(" ").trim() || flagString(args, "title") || "";
  if (!title) {
    throw new Error(
      'Usage: ticketrail add "card title" [--description "..."] [--column backlog] [--type feature] [--label x] [--related 12,14]'
    );
  }
  const descriptionFile = flagString(args, "description-file");
  const description = descriptionFile ? descriptionFile === "-" ? textInput(args, [], ["description-file"]) : fs18.readFileSync(descriptionFile, "utf8") : flagString(args, "description") ?? "";
  const column = flagString(args, "column");
  if (column && !isColumn(column)) throw new Error(`Unknown column "${column}". One of: ${COLUMNS.join(", ")}`);
  const task = store.create({
    title,
    description,
    column: column ?? "backlog",
    position: flagBool(args, "bottom") ? "bottom" : "top",
    type: readType(args),
    labels: flagList(args, "label"),
    related: flagList(args, "related").flatMap((r) => r.split(",")).map((r) => store.find(r.trim())?.id ?? ""),
    folder: readFolder(store, args),
    agent: readAgentFlag(store, args),
    worker: flagString(args, "for") ?? null
  });
  console.log(`#${task.number} "${task.title}" -> ${COLUMN_LABELS[task.column]}  (${task.id})`);
}
function readAgentFlag(store, args) {
  const name = flagString(args, "agent");
  if (name === void 0) return null;
  return requireAgent(store, name);
}
function requireAgent(store, name) {
  if (!isAgentName(name)) throw new Error(`"${name}" is not a valid agent name`);
  if (!agentExists(store.root, name)) {
    const known = listAgents(store.root).map((a) => a.name);
    throw new Error(`No agent "${name}" in .claude/agents/.${known.length ? ` Known: ${known.join(", ")}` : ""}`);
  }
  return name;
}
function assignCommand(store, positional) {
  const [ref, target] = positional;
  if (!ref || !target) throw new Error("Usage: ticketrail assign <card id or #number> <agent name|none>");
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const agent = target === "none" ? null : requireAgent(store, target);
  const updated = store.patch(task.id, { agent });
  console.log(`#${updated.number} ${agent ? `-> agent "${agent}"` : "is no longer assigned to an agent"}`);
}
function sendCommand(store, positional) {
  const [ref, target] = positional;
  if (!ref || !target) throw new Error("Usage: ticketrail send <card id or #number> <worker name|none>");
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const updated = store.patch(task.id, { worker: target === "none" ? null : target });
  console.log(`#${updated.number} ${updated.worker ? `-> worker "${updated.worker}" only` : "can be taken by any worker"}`);
}
function agentsCommand(store) {
  printJson(listAgents(store.root));
}
function readFolder(store, args) {
  const ref = flagString(args, "folder");
  if (ref === void 0) return null;
  const folder = store.findFolder(ref);
  if (!folder) throw new Error(`No folder "${ref}". Create it with: ticketrail folder add "${ref}"`);
  return folder.id;
}
function readType(args) {
  const value = flagString(args, "type");
  if (value === void 0) return null;
  if (!isTaskType(value)) throw new Error(`Unknown type "${value}". One of: ${TASK_TYPES.join(", ")}`);
  return value;
}
function labelCommand(store, args, positional) {
  const [id] = positional;
  const add = flagList(args, "add");
  const remove = flagList(args, "remove");
  if (!id || !add.length && !remove.length) {
    throw new Error("Usage: ticketrail label <id> [--add <label>]... [--remove <label>]...");
  }
  const task = store.get(id);
  if (!task) throw new Error(`No task with id "${id}"`);
  const dropped = new Set(remove.map((l) => l.trim().toLowerCase()));
  const kept = task.labels.filter((l) => !dropped.has(l.toLowerCase()));
  const updated = store.patch(id, { labels: [...kept, ...add] });
  console.log(`#${updated.number} labels: ${updated.labels.join(", ") || "(none)"}`);
}
function deriveCommand(store, positional) {
  const [id] = positional;
  if (!id) throw new Error("Usage: ticketrail derive <id>   (spawn a Feature card from an investigation)");
  const task = store.deriveImplementation(id);
  console.log(`#${task.number} "${task.title}" -> ${COLUMN_LABELS[task.column]}  (${task.id})`);
}
function showCommand(store, positional) {
  const [id] = positional;
  if (!id) throw new Error("Usage: ticketrail show <id>");
  const task = store.find(id);
  if (!task) throw new Error(`No task with id "${id}"`);
  const summary = (t) => ({ id: t.id, number: t.number, title: t.title, column: t.column });
  printJson({
    ...withPaths(store, task),
    ...task.folder ? { folderName: store.findFolder(task.folder)?.name ?? null } : {},
    relatedCards: store.relatedOf(task).map(summary),
    referencedBy: store.referencedBy(task.id).map(summary)
  });
}
function relateCommand(store, positional, unlink = false) {
  const [ref, ...others] = positional;
  const verb = unlink ? "unrelate" : "relate";
  if (!ref || !others.length) throw new Error(`Usage: ticketrail ${verb} <id> <other id or #number>...`);
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const ids = others.map((o) => {
    const found = store.find(o);
    if (!found) throw new Error(`No task with id "${o}"`);
    return found.id;
  });
  const related = unlink ? task.related.filter((r) => !ids.includes(r)) : [...task.related, ...ids];
  const updated = store.patch(task.id, { related });
  const numbers = store.relatedOf({ ...updated, derivedFrom: null }).map((t) => `#${t.number}`);
  console.log(`#${updated.number} related: ${numbers.join(", ") || "(none)"}`);
}
function listCommand(store, args) {
  const column = flagString(args, "column");
  if (column && !isColumn(column)) throw new Error(`Unknown column "${column}". One of: ${COLUMNS.join(", ")}`);
  const type = flagString(args, "type");
  if (type && !isTaskType(type)) throw new Error(`Unknown type "${type}". One of: ${TASK_TYPES.join(", ")}`);
  const wanted = flagList(args, "label").map((l) => l.toLowerCase());
  const folder = flagString(args, "folder") !== void 0 ? readFolder(store, args) : void 0;
  const tasks = store.list().filter(
    (t) => (!column || t.column === column) && (folder === void 0 || t.folder === folder) && (!type || t.type === type) && (!wanted.length || wanted.every((w) => t.labels.some((l) => l.toLowerCase() === w)))
  );
  printJson(
    tasks.map(({ activity, messages, ...rest }) => ({
      ...rest,
      activityCount: activity.length,
      messageCount: messages.length
    }))
  );
}
function moveCommand(store, positional) {
  const [id, column] = positional;
  if (!id || !isColumn(column)) {
    throw new Error(`Usage: ticketrail move <id> <${COLUMNS.join("|")}>`);
  }
  const task = store.move(id, column);
  console.log(`#${task.number} "${task.title}" -> ${COLUMN_LABELS[task.column]}`);
}
function statusCommand(store) {
  const tasks = store.list();
  const server = fs18.existsSync(store.paths.serverInfo) ? JSON.parse(fs18.readFileSync(store.paths.serverInfo, "utf8")) : null;
  console.log(`Ticketrail \xB7 ${store.root}`);
  console.log(server ? `  server ${server.url} (pid ${server.pid})` : "  server not running \u2014 ticketrail serve");
  console.log("");
  for (const column of COLUMNS) {
    const inColumn = tasks.filter((t) => t.column === column);
    if (!inColumn.length) continue;
    console.log(`  ${COLUMN_LABELS[column]} (${inColumn.length})`);
    for (const task of inColumn) {
      const waiting = pendingQuestion(task) ? "  \u2190 needs your answer" : "";
      const tags = [task.type ? TYPE_LABELS[task.type] : null, ...task.labels].filter(Boolean);
      const suffix = tags.length ? `  [${tags.join(", ")}]` : "";
      console.log(`    #${task.number}  ${task.title}${suffix}${waiting}`);
    }
  }
  if (!tasks.length) console.log("  the board is empty");
}
function foldersCommand(store) {
  const tasks = store.list();
  printJson(store.folders().map((f) => ({ ...f, cards: tasks.filter((t) => t.folder === f.id).length })));
}
function folderCommand(store, args, positional) {
  const [action, ref, ...rest] = positional;
  const usage = 'Usage: ticketrail folder add "name" [--color sky] | rename <folder> "new name" | color <folder> <colour> | remove <folder>';
  const resolve = () => {
    const found = ref ? store.findFolder(ref) : null;
    if (!found) throw new Error(ref ? `No folder "${ref}"` : usage);
    return found;
  };
  switch (action) {
    case "add": {
      const name = [ref, ...rest].filter(Boolean).join(" ");
      if (!name) throw new Error(usage);
      const color = flagString(args, "color");
      if (color && !isFolderColor(color)) throw new Error(`Unknown colour "${color}". One of: ${FOLDER_COLORS.join(", ")}`);
      const folder = store.createFolder({ name, color });
      return console.log(`folder "${folder.name}" created  (${folder.id})`);
    }
    case "rename": {
      const folder = store.updateFolder(resolve().id, { name: rest.join(" ") });
      return console.log(`folder renamed to "${folder.name}"`);
    }
    case "color": {
      const [color] = rest;
      if (!isFolderColor(color)) throw new Error(`Unknown colour "${color}". One of: ${FOLDER_COLORS.join(", ")}`);
      const folder = store.updateFolder(resolve().id, { color });
      return console.log(`folder "${folder.name}" is now ${folder.color}`);
    }
    case "remove": {
      const folder = resolve();
      store.deleteFolder(folder.id);
      return console.log(`folder "${folder.name}" removed; its cards are kept, unfiled`);
    }
    default:
      throw new Error(usage);
  }
}
function fileCommand(store, positional) {
  const [ref, ...rest] = positional;
  const target = rest.join(" ");
  if (!ref || !target) throw new Error("Usage: ticketrail file <card id or #number> <folder name|id|none>");
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const folder = target === "none" ? null : store.findFolder(target);
  if (target !== "none" && !folder) throw new Error(`No folder "${target}"`);
  const updated = store.patch(task.id, { folder: folder?.id ?? null });
  console.log(`#${updated.number} ${folder ? `-> folder "${folder.name}"` : "is no longer in a folder"}`);
}

// src/cli/commands/projects.ts
import path18 from "path";
function projectsCommand(args, positional) {
  const [action, target] = positional;
  if (action === "add") {
    if (!target) throw new Error("Usage: ticketrail projects add <path>");
    const root = path18.resolve(target);
    if (!isBoard(root)) {
      throw new Error(`${root} has no board. Run "ticketrail init" there first.`);
    }
    const record = addProject(root);
    console.log(`registered ${record.path}  (${record.id})`);
    return;
  }
  if (action === "remove") {
    if (!target) throw new Error("Usage: ticketrail projects remove <path|id>");
    const record = removeProject(target);
    console.log(record ? `removed ${record.path}` : `not registered: ${target}`);
    return;
  }
  if (action && action !== "list") {
    throw new Error(`Usage: ticketrail projects [list|add <path>|remove <path|id>]`);
  }
  const projects = describeProjects();
  if (flagBool(args, "json")) return printJson(projects);
  if (!projects.length) {
    console.log("No projects registered yet.");
    console.log('Run "ticketrail init" in a project, or "ticketrail projects add <path>".');
    return;
  }
  console.log(`Projects (${registryHome()}/projects.json)
`);
  for (const p of projects) {
    if (p.missing) {
      console.log(`  ${p.name.padEnd(20)} ${p.shortPath}  \u2014 missing, remove with "projects remove ${p.id}"`);
      continue;
    }
    const bits = [
      p.summary.queued ? `${p.summary.queued} queued` : "",
      p.summary.inProgress ? `${p.summary.inProgress} in progress` : "",
      p.summary.blocked ? `${p.summary.blocked} waiting on you` : ""
    ].filter(Boolean);
    console.log(`  ${p.name.padEnd(20)} ${p.shortPath}${bits.length ? `  \xB7 ${bits.join(" \xB7 ")}` : ""}`);
  }
}

// src/cli/commands/work.ts
import fs20 from "fs";

// src/core/filter.ts
var KINDS = ["label", "agent", "folder", "type"];
function emptyFilter() {
  return { labels: [], agents: [], folders: [], types: [] };
}
function isEmptyFilter(filter) {
  return !filter.labels.length && !filter.agents.length && !filter.folders.length && !filter.types.length;
}
function parseFilter(specs, folders) {
  const filter = emptyFilter();
  for (const term of specs.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)) {
    const at = term.indexOf(":");
    const kind = at > 0 ? term.slice(0, at).toLowerCase() : "";
    const value = at > 0 ? term.slice(at + 1).trim() : "";
    if (!value || !KINDS.includes(kind)) {
      throw new Error(`Cannot read the filter "${term}". Use ${KINDS.map((k) => `${k}:<value>`).join(", ")}`);
    }
    const none = value.toLowerCase() === "none";
    if (kind === "label") filter.labels.push(value.toLowerCase());
    if (kind === "agent") filter.agents.push(none ? null : value);
    if (kind === "type") {
      if (!none && !isTaskType(value)) throw new Error(`Unknown type "${value}" in the filter`);
      filter.types.push(none ? null : value);
    }
    if (kind === "folder") {
      if (none) {
        filter.folders.push(null);
        continue;
      }
      const folder = folders.find((f) => f.id === value || f.name.toLowerCase() === value.toLowerCase());
      if (!folder) throw new Error(`No folder "${value}" for the filter`);
      filter.folders.push(folder.id);
    }
  }
  return filter;
}
function matchesFilter(task, filter) {
  if (filter.labels.length && !task.labels.some((l) => filter.labels.includes(l.toLowerCase()))) return false;
  if (filter.agents.length && !filter.agents.includes(task.agent ?? null)) return false;
  if (filter.folders.length && !filter.folders.includes(task.folder ?? null)) return false;
  if (filter.types.length && !filter.types.includes(task.type ?? null)) return false;
  return true;
}
function describeFilter(filter, folders = []) {
  const folderName = (id) => id === null ? "none" : folders.find((f) => f.id === id)?.name ?? id;
  return [
    ...filter.labels.map((l) => `label:${l}`),
    ...filter.agents.map((a) => `agent:${a ?? "none"}`),
    ...filter.folders.map((f) => `folder:${folderName(f)}`),
    ...filter.types.map((t) => `type:${t ?? "none"}`)
  ].join(",");
}

// src/core/news.ts
import fs19 from "fs";
import path19 from "path";
function markerFile(store, taskId) {
  return path19.join(store.paths.runtime, "seen", taskId);
}
function seenSince(store, task) {
  let marker = "";
  try {
    marker = fs19.readFileSync(markerFile(store, task.id), "utf8").trim();
  } catch {
  }
  const start = task.startedAt ?? task.createdAt;
  return marker && marker > start ? marker : start;
}
function unseenNews(store, task) {
  const since = seenSince(store, task);
  const answers = new Set(task.messages.map((m) => m.answeredBy).filter(Boolean));
  return {
    messages: task.messages.filter((m) => m.role === "user" && m.at > since && !answers.has(m.id)).map((m) => ({ at: m.at, text: m.text })),
    files: task.attachments.filter((a) => a.addedBy === "user" && a.addedAt > since).map((a) => ({ name: a.name, path: store.filePath(a), mime: a.mime }))
  };
}
function hasNews(news) {
  return news.messages.length > 0 || news.files.length > 0;
}
function markSeen(store, task) {
  try {
    const file = markerFile(store, task.id);
    fs19.mkdirSync(path19.dirname(file), { recursive: true });
    fs19.writeFileSync(file, (/* @__PURE__ */ new Date()).toISOString());
  } catch {
  }
}
function describeNews(news) {
  const lines = ["NEW FROM THE USER while you work on this card. Take it into account before you go on:"];
  for (const m of news.messages) lines.push(`- message: ${m.text.replace(/\s*\n\s*/g, " ")}`);
  for (const f of news.files) lines.push(`- file "${f.name}": ${f.path}  (open it)`);
  return lines.join("\n");
}

// src/cli/commands/work.ts
function refuseWithNews(store, id, command) {
  const task = store.get(id);
  if (!task || task.column !== "in-progress") return;
  const news = unseenNews(store, task);
  if (!hasNews(news)) return;
  markSeen(store, task);
  throw new Error(
    `${describeNews(news)}

Not finished yet: read the above, adjust your work if it changes anything, then run \`ticketrail ${command} ${id} ...\` again.`
  );
}
function codeChanged(script = process.argv[1]) {
  const stamp = () => {
    try {
      return script ? fs20.statSync(fs20.realpathSync(script)).mtimeMs : null;
    } catch {
      return null;
    }
  };
  const started = stamp();
  return () => {
    if (started === null) return false;
    const now2 = stamp();
    return now2 !== null && now2 !== started;
  };
}
var UPDATED_NOTE = "ticketrail was updated while this worker waited. Run next again; it uses the new version.";
function workerSpec(store, args) {
  const name = flagString(args, "worker") ?? null;
  if (name !== null && !isWorkerName(name)) {
    throw new Error(`"${name}" is not a usable worker name: letters, digits, ".", "_" and "-", at most 40 characters`);
  }
  const folders = store.folders();
  const filter = parseFilter(flagList(args, "only"), folders);
  if (isEmptyFilter(filter)) return { name, filter: null, label: null };
  return { name, filter, label: describeFilter(filter, folders) };
}
function matcher(spec) {
  const filter = spec.filter;
  return filter ? (task) => matchesFilter(task, filter) : () => true;
}
function claimable(spec) {
  const filter = matcher(spec);
  return (task) => task.worker ? task.worker === spec.name : filter(task);
}
var DEFAULT_TIMEOUT_S = 500;
function timeoutMs(args) {
  return Math.max(0, flagNumber(args, "timeout", DEFAULT_TIMEOUT_S)) * 1e3;
}
async function waitCommand(store, args) {
  const seconds = Math.max(0, flagNumber(args, "timeout", 0));
  const spec = workerSpec(store, args);
  const match = claimable(spec);
  const updated = codeChanged();
  const probe = () => {
    if (updated()) return { updated: true };
    const implement = store.column("implement").filter(match).length;
    const plan = store.column("plan").filter(match).length;
    return implement || plan ? { implement, plan } : null;
  };
  const stop = startHeartbeat(store, { name: spec.name, filter: spec.label });
  let ready;
  try {
    ready = await waitFor(store, probe, seconds === 0 ? Infinity : seconds * 1e3);
  } finally {
    stop();
  }
  touchWorker(store);
  if (ready && "updated" in ready) return printJson({ status: "updated", note: UPDATED_NOTE });
  printJson(ready ? { status: "ready", ...ready } : { status: "timeout" });
}
function claimWorkable(store, spec) {
  for (; ; ) {
    const task = store.claimNext({ worker: spec.name, match: matcher(spec) });
    if (!task?.agent || agentExists(store.root, task.agent)) return task;
    store.fail(
      task.id,
      `This card is assigned to the agent "${task.agent}", but .claude/agents/${task.agent}.md does not exist. Create that agent, pick another one, or clear the agent field, then move the card back.`
    );
  }
}
async function nextCommand(store, args) {
  const spec = workerSpec(store, args);
  touchWorker(store);
  let task;
  if (flagBool(args, "wait")) {
    const updated = codeChanged();
    const stop = startHeartbeat(store, { name: spec.name, filter: spec.label });
    let got;
    try {
      got = await waitFor(store, () => updated() ? "updated" : claimWorkable(store, spec), timeoutMs(args));
    } finally {
      stop();
    }
    touchWorker(store);
    if (got === "updated") return printJson({ status: "none", reason: "updated", note: UPDATED_NOTE });
    task = got;
  } else {
    task = claimWorkable(store, spec);
  }
  if (!task) return printJson({ status: "none" });
  const related = relatedContext(store, task);
  const folder = task.folder ? store.findFolder(task.folder) : null;
  const agent = task.agent ? readAgent(store.root, task.agent) : null;
  const worktree = findWorktree();
  printJson({
    status: "claimed",
    mode: task.mode,
    type: task.type,
    ...spec.name ? { worker: spec.name } : {},
    task: withPaths(store, task),
    ...worktree ? {
      worktree: { path: worktree.path, branch: worktree.branch },
      worktreeNote: `You are working in the git worktree ${worktree.path}` + (worktree.branch ? ` on branch ${worktree.branch}` : "") + ". Make your changes there, not in the main checkout, and name the worktree and branch in your summary so the user can review and merge them."
    } : {},
    ...folder ? { folderName: folder.name } : {},
    ...task.attachments.length ? { attachmentNote: `This card has ${task.attachments.length} file(s). Read each attachments[].path before you start.` } : {},
    ...related.length ? {
      relatedCards: related,
      relatedNote: `This card links ${related.length} related card(s). Read their plan and result for context before you start. They are context, not work: do not edit, move or claim them.`
    } : {},
    ...agent ? { agent: { name: agent.name, description: agent.description, path: agent.path } } : {},
    guidance: agent ? delegationFor(task, agent.path) : guidanceFor(task)
  });
}
function delegationFor(task, agentPath) {
  const name = task.agent;
  return `This card is assigned to the project agent "${name}". Do not do the work yourself: delegate the whole card to it with the Agent tool (subagent_type "${name}"). If that agent type is unknown to this session (it was created after the session started), use a general-purpose subagent and tell it to follow ${agentPath} as its instructions. In the prompt, give it the card id, title, description, plan, attachment paths and related-card context from this output, tell it to log milestones with ticketrail log <id> "...", and give it this instruction: ${guidanceFor(task)} If it cannot finish, it must run ticketrail fail <id> "reason". When the subagent returns, run ticketrail check <id>; if the card is still In Progress, finish it yourself from the subagent's report with the same command.`;
}
function guidanceFor(task) {
  if (task.type === "investigation") {
    return "This is an Investigation card. Research the codebase and write your findings into the plan. Do not change any code and do not create or edit files outside the plan. Finish with: ticketrail plan <id> --file <plan.md>";
  }
  if (task.type === "question") {
    return "This is a Question card. Answer it \u2014 do not change any code. Finish with: ticketrail done <id> --file <answer.md>, so the answer is on the card.";
  }
  if (task.mode === "plan") return "Research and write a plan, then: ticketrail plan <id> --file <plan.md>";
  return task.plan ? "Implement the plan stored on this card, then: ticketrail done <id> --file <summary.md>" : "No plan on this card \u2014 implement from the description, then: ticketrail done <id> --file <summary.md>";
}
function logCommand(store, args, positional) {
  const [id, ...rest] = positional;
  const text = textInput(args, rest);
  if (!id || !text) throw new Error('Usage: ticketrail log <id> "what you just did" [--kind info|file|test|error]');
  const kind = flagString(args, "kind") ?? "info";
  touchWorker(store);
  store.activity(id, text, kind);
  const task = store.get(id);
  console.log(`logged to #${task?.number ?? id}`);
  if (task?.column === "in-progress") {
    const news = unseenNews(store, task);
    if (hasNews(news)) {
      markSeen(store, task);
      console.log(`
${describeNews(news)}`);
    }
  }
}
async function askCommand(store, args, positional) {
  const [id, ...rest] = positional;
  const question = textInput(args, rest);
  if (!id || !question) throw new Error('Usage: ticketrail ask <id> "your question" [--wait]');
  const { message } = store.ask(id, question);
  if (!flagBool(args, "wait")) {
    return printJson({ status: "asked", questionId: message.id, task: store.get(id) });
  }
  const probe = () => {
    const task = store.get(id);
    if (!task) return null;
    const asked = task.messages.find((m) => m.id === message.id);
    if (!asked?.answeredBy) return null;
    const answer = task.messages.find((m) => m.id === asked.answeredBy);
    return answer ? { task, answer } : null;
  };
  touchWorker(store);
  const stop = startHeartbeat(store);
  let result;
  try {
    result = await waitFor(store, probe, timeoutMs(args));
  } finally {
    stop();
  }
  touchWorker(store);
  if (!result) {
    return printJson({
      status: "pending",
      questionId: message.id,
      task: store.get(id),
      guidance: "Nobody answered yet. The card stays in User Input \u2014 stop working on it and tell the user you are waiting."
    });
  }
  printJson({ status: "answered", answer: result.answer.text, task: result.task });
}
function planCommand(store, args, positional) {
  const [id, ...rest] = positional;
  const plan = textInput(args, rest, ["file", "plan-file"]);
  if (!id || !plan) throw new Error('Usage: ticketrail plan <id> --file <plan.md>  (or --text "..." or - for stdin)');
  touchWorker(store);
  refuseWithNews(store, id, "plan");
  const task = store.savePlan(id, plan);
  console.log(`#${task.number} "${task.title}" -> Planned (${plan.length} chars). Waiting for review.`);
}
function doneCommand(store, args, positional) {
  const [id, ...rest] = positional;
  const result = textInput(args, rest, ["file", "summary-file"]);
  if (!id) throw new Error('Usage: ticketrail done <id> --file <summary.md>  (or --text "..." or - for stdin)');
  touchWorker(store);
  refuseWithNews(store, id, "done");
  const task = store.finish(id, result || "Finished.");
  console.log(`#${task.number} "${task.title}" -> Done.`);
}
function failCommand(store, args, positional) {
  const [id, ...rest] = positional;
  const reason = textInput(args, rest);
  if (!id || !reason) throw new Error('Usage: ticketrail fail <id> "why you stopped"');
  touchWorker(store);
  const task = store.fail(id, reason);
  console.log(`#${task.number} "${task.title}" -> User Input. Waiting for the user.`);
}
function checkCommand(store, positional) {
  const [id] = positional;
  const task = id ? store.get(id) : null;
  if (!task) throw new Error(`Usage: ticketrail check <id>`);
  touchWorker(store);
  const working = !task.cancelRequested && task.column === "in-progress";
  const news = working ? unseenNews(store, task) : null;
  if (news && hasNews(news)) markSeen(store, task);
  printJson({
    status: working ? "ok" : "cancelled",
    column: task.column,
    cancelRequested: task.cancelRequested,
    ...news && hasNews(news) ? {
      news,
      newsNote: "The user added this while you work on the card. Read the messages, open the files, and take them into account."
    } : {}
  });
}

// src/cli/index.ts
var HELP = `ticketrail \u2014 a kanban board your project and Claude Code share

  init [--port] [--title] [--force]  create .ticketrail/ and install the Claude skill
  serve [--port] [--open]          run the board UI + API

Working the board (this is what /ticketrail-work uses):
  next [--wait] [--timeout 500]    claim the top card of Implement, else Plan  -> JSON
  wait [--timeout 0]               block until Plan/Implement has a card; never claims (0 = no limit)
    both take --worker <name> and --only <filter> for parallel workers, e.g.
    --worker fe --only label:frontend,type:bug   (label: agent: folder: type:, "none" allowed)
  check <id>                       has the user pulled this card back?          -> JSON
  log <id> "text" [--kind]         append to the card's activity feed
  ask <id> "question" [--wait]     park on User Input, block for the answer     -> JSON
  plan <id> --file <plan.md>       store the plan, move to Planned
  done <id> --file <summary.md>    store the result, move to Done
  fail <id> "reason"               stop and hand the card back to the user
  files <id>                       the card's attachments, with paths to open  -> JSON
  attach <id> <file>...            attach a file to the card
  detach <id> <fileId>             remove an attachment

Everyday:
  add "title" [--description] [--column] [--type] [--label] [--related] [--folder] [--agent] [--for <worker>]   create a card
  list [--column] [--type] [--label] [--folder]   the board as JSON
  show <id>                                one card as JSON
  move <id> <column>                       move a card
  label <id> --add x [--remove y]          edit a card's labels
  derive <id>                              spawn a Feature card from an investigation
  relate <id> <other>...                   link cards whose context Claude reads with this one
  unrelate <id> <other>...                 remove those links
  folders                                  the board's folders as JSON (optional grouping)
  folder add "name" [--color]              create a folder  (also: rename, color, remove)
  file <id> <folder|none>                  put a card in a folder, or take it out
  agents                                   the project's agents (.claude/agents) as JSON
  assign <id> <agent|none>                 hand a card to an agent; the worker delegates it
  send <id> <worker|none>                  only that named worker may claim the card
  status                                   human-readable summary
  projects [add|remove <path>]             boards the switcher offers

Text arguments accept --text "...", --file <path>, or --file - for stdin.
In a linked git worktree the CLI uses the main checkout's board, so parallel
workers in separate worktrees share one board. TICKETRAIL_ROOT=<path> overrides.

The model behind each status change is recorded on the card. It is read from the
Claude Code session; pass --model <id> to say so yourself, or set recordModel to
false in .ticketrail/config.json to record nothing.
`;
async function main() {
  const [, , command = "help", ...rest] = process.argv;
  const args = parseArgs(rest);
  const positional = args.positional;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log("ticketrail 0.1.0");
    return;
  }
  if (command === "init") return initCommand(args);
  if (command === "projects") return projectsCommand(args, positional);
  const store = new Store(requireRoot());
  if (store.config().recordModel !== false) store.model = resolveModel(flagString(args, "model"));
  if (store.config().liveSession !== false) store.session = currentSession();
  switch (command) {
    case "serve":
      return serveCommand(store, args);
    case "next":
      return nextCommand(store, args);
    case "wait":
      return waitCommand(store, args);
    case "check":
      return checkCommand(store, positional);
    case "log":
      return logCommand(store, args, positional);
    case "ask":
      return askCommand(store, args, positional);
    case "plan":
      return planCommand(store, args, positional);
    case "done":
      return doneCommand(store, args, positional);
    case "fail":
      return failCommand(store, args, positional);
    case "attach":
      return attachCommand(store, args, positional);
    case "files":
      return filesCommand(store, positional);
    case "detach":
      return detachCommand(store, positional);
    case "add":
      return addCommand(store, args, positional);
    case "list":
      return listCommand(store, args);
    case "show":
      return showCommand(store, positional);
    case "move":
      return moveCommand(store, positional);
    case "label":
      return labelCommand(store, args, positional);
    case "derive":
      return deriveCommand(store, positional);
    case "relate":
      return relateCommand(store, positional);
    case "unrelate":
      return relateCommand(store, positional, true);
    case "folders":
      return foldersCommand(store);
    case "folder":
      return folderCommand(store, args, positional);
    case "file":
      return fileCommand(store, positional);
    case "agents":
      return agentsCommand(store);
    case "assign":
      return assignCommand(store, positional);
    case "send":
      return sendCommand(store, positional);
    case "status":
      return statusCommand(store);
    default:
      process.stderr.write(`Unknown command "${command}"

${HELP}`);
      process.exitCode = 1;
  }
}
main().catch((err) => {
  process.stderr.write(`${err.message}
`);
  process.exitCode = 1;
});
