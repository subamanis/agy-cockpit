'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 8091;
const SIDECAR_NAME = 'agy-cockpit';
const GITHUB_REPO = 'subamanis/agy-cockpit';
const GITHUB_BRANCH = 'main';
const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const APP_CANDIDATES = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENDER_UUID_RE = /\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![/a-z0-9_-])/i;
const CHILD_CONV_RE = /\bconversation(?:Id|_id)?["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const GIT_COMMIT_OUT_RE = /\[[\w./-]+(?:\s+\([^)]+\))?\s+([0-9a-f]{7,12})\]/g;

const FALLBACK_PRELOAD_JS = `(function() {
  const params = new URLSearchParams(window.location.search);
  const boot = window.__SIDECAR_BOOT__ || {};
  const token = params.get('token') || boot.token || '';
  const conversationId = params.get('conversationId') || boot.conversationId || '';
  let currentWorkspaceUris = [];
  let hasInitialWorkspace = false;
  const workspaceListeners = new Set();
  let resolveInitialWorkspace;
  const initialWorkspacePromise = new Promise((r) => { resolveInitialWorkspace = r; });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'theme-change') {
      const vars = (event.data.payload && event.data.payload.cssVariables) || {};
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    } else if (event.data && event.data.type === 'workspace-change') {
      const payload = event.data.payload || {};
      currentWorkspaceUris = Array.isArray(payload.workspaceUris) ? [...payload.workspaceUris] : [];
      hasInitialWorkspace = true;
      resolveInitialWorkspace();
      for (const fn of workspaceListeners) {
        try { fn([...currentWorkspaceUris]); } catch (e) {}
      }
    }
  });

  function secureFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Sidecar-Token', token);
    return fetch(url, { ...options, headers });
  }

  async function getWorkspaceUris() {
    if (window.parent === window) return [];
    await Promise.race([initialWorkspacePromise, new Promise((r) => setTimeout(r, 400))]);
    return [...currentWorkspaceUris];
  }

  window.sidecar = {
    conversationId,
    fetch: secureFetch,
    getWorkspaceUris,
    onWorkspaceChange(listener) {
      if (typeof listener !== 'function') return () => {};
      workspaceListeners.add(listener);
      if (hasInitialWorkspace) {
        queueMicrotask(() => { if (workspaceListeners.has(listener)) listener([...currentWorkspaceUris]); });
      }
      return () => { workspaceListeners.delete(listener); };
    },
    agent: {
      async sendMessage(message, convId) {
        const res = await secureFetch('/_sidecar/send-message', {
          method: 'POST',
          body: JSON.stringify({ conversationId: convId || conversationId, message })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data && data.error)) {
          throw new Error((data && data.error) || 'Failed to send message to agent');
        }
        return data;
      },
      async startConversation(message, opts = {}) {
        const payload = { message };
        if (opts && typeof opts === 'object') {
          if (opts.model) payload.model = opts.model;
          if (opts.modelId) payload.modelId = opts.modelId;
          if (opts.conversationId) payload.conversationId = opts.conversationId;
          if (opts.projectId) payload.projectId = opts.projectId;
          if (opts.workspacePath) payload.workspacePath = opts.workspacePath;
          if (opts.general) payload.general = true;
        }
        const res = await secureFetch('/_sidecar/new-conversation', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data && data.error)) {
          throw new Error((data && data.error) || 'Failed to start conversation');
        }
        return data;
      }
    },
    ui: {
      toggleConversation(convId) {
        window.parent.postMessage({ type: 'toggle-conversation', payload: { conversationId: convId } }, '*');
      },
      toggleAuxPane(request) {
        window.parent.postMessage({ type: 'toggle-aux-pane', payload: request }, '*');
      }
    }
  };
})();`;

function isDirectory(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function resolveAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir && isDirectory(envDir)) return envDir;
  const geminiRoot = path.join(os.homedir(), '.gemini');
  for (const appName of APP_CANDIDATES) {
    const candidate = path.join(geminiRoot, appName);
    if (isDirectory(path.join(candidate, 'brain'))) return candidate;
  }
  for (const appName of APP_CANDIDATES) {
    const candidate = path.join(geminiRoot, appName);
    if (isDirectory(candidate)) return candidate;
  }
  return path.join(geminiRoot, 'antigravity');
}

function resolveProjectsDir() {
  const envDir = process.env.ANTIGRAVITY_PROJECTS_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.gemini', 'config', 'projects');
}

function extractProjectResourcePaths(rawProject) {
  const out = [];
  const seen = new Set();
  const addUri = (uri) => {
    if (!uri || typeof uri !== 'string') return;
    const norm = normalizeWorkspacePath(uri);
    if (!norm) return;
    const key = workspaceComparisonKey(norm);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ path: norm, key, label: getWorkspaceLabel(norm) });
  };

  const resources = rawProject?.projectResources?.resources;
  if (Array.isArray(resources)) {
    for (const r of resources) {
      if (!r || typeof r !== 'object') continue;
      addUri(r.folderUri || r.gitFolder?.folderUri || r.google3Folder?.folderUri);
    }
  }
  const envs = rawProject?.environments?.environments;
  if (Array.isArray(envs)) {
    for (const env of envs) {
      const envRes = env?.resources?.resources;
      if (Array.isArray(envRes)) {
        for (const r of envRes) {
          if (!r || typeof r !== 'object') continue;
          addUri(r.folderUri || r.gitFolder?.folderUri || r.google3Folder?.folderUri);
        }
      }
    }
  }
  return out;
}

function resolveDataDir(appDataDir) {
  const envExecDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envExecDir) {
    try {
      fs.mkdirSync(envExecDir, { recursive: true });
      return envExecDir;
    } catch {}
  }
  const primary = path.join(appDataDir, 'sidecar_data', SIDECAR_NAME, 'data');
  try {
    fs.mkdirSync(primary, { recursive: true });
    return primary;
  } catch {
    const fallback = path.join(os.tmpdir(), 'gemini', 'antigravity', 'sidecar_data', SIDECAR_NAME, 'data');
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }
}

function writeFileAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  try {
    fs.writeFileSync(tmpPath, Buffer.isBuffer(content) ? content : String(content), Buffer.isBuffer(content) ? (mode ? { mode } : undefined) : { encoding: 'utf-8', mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

function writeJsonAtomic(filePath, data, mode, pretty = false) {
  writeFileAtomic(filePath, pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data), mode);
}

function normalizeWorkspacePath(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let p = rawInput.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ''));
      if (process.platform !== 'win32' && !p.startsWith('/')) p = '/' + p;
    }
  }
  p = p.replace(/^["']+|["']+$/g, '').trim();
  p = p.replace(/\\\\/g, '/').replace(/\\/g, '/');
  if (p.length > 1 && p.endsWith('/')) {
    p = p.replace(/\/+$/, '');
  }
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
  return p;
}

function workspaceComparisonKey(normPath) {
  if (!normPath) return '';
  return process.platform === 'win32' ? normPath.toLowerCase() : normPath;
}

function getWorkspaceLabel(normPath) {
  if (!normPath) return 'Unscoped / General';
  const parts = normPath.split('/').filter(Boolean);
  if (parts.length === 0) return normPath;
  return parts[parts.length - 1];
}

const gitRootLookupCache = new Map();
const knownProjectRootPaths = new Map();

function findGitOrWorkspaceRoot(rawCandidatePath) {
  const norm = normalizeWorkspacePath(rawCandidatePath);
  if (!norm) return '';
  const lower = norm.toLowerCase();
  if (
    lower.includes('/.gemini/') ||
    lower.includes('/node_modules/')
  ) {
    return '';
  }
  let curr = norm;
  const visited = [];
  let foundRoot = '';

  for (let depth = 0; depth < 14; depth++) {
    if (!curr || curr === '/' || /^[a-z]:$/i.test(curr)) break;
    if (gitRootLookupCache.has(curr)) {
      foundRoot = gitRootLookupCache.get(curr);
      break;
    }
    visited.push(curr);
    const gitMarker = path.join(curr, '.git');
    try {
      if (fs.existsSync(gitMarker)) {
        foundRoot = curr;
        break;
      }
    } catch {}
    const currKey = workspaceComparisonKey(curr);
    if (knownProjectRootPaths.has(currKey)) {
      foundRoot = knownProjectRootPaths.get(currKey) || curr;
      break;
    }
    const parent = path.posix.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  if (gitRootLookupCache.size > 4096) {
    gitRootLookupCache.clear();
  }
  for (const v of visited) {
    gitRootLookupCache.set(v, foundRoot);
  }
  return foundRoot;
}

function resolveCanonicalWorkspace(rawCandidatePath) {
  const norm = normalizeWorkspacePath(rawCandidatePath);
  if (!norm) return '';
  return findGitOrWorkspaceRoot(norm) || norm;
}

function cleanUserPrompt(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent;
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    const sysMsgMatch = /^The following is a <SYSTEM_MESSAGE>[\s\S]*?<SYSTEM_MESSAGE[^>]*>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(text);
    if (sysMsgMatch && sysMsgMatch[1].trim()) {
      text = sysMsgMatch[1];
    } else {
      text = text
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi, '');
    }
  }
  return text.replace(/\r\n/g, '\n').trim();
}

function isSmartHandoffRequestText(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return false;
  const trimmed = rawContent.trimStart();
  if (trimmed.startsWith('[AGY Cockpit Smart Handoff]')) return true;
  return trimmed.includes('<USER_REQUEST>') && cleanUserPrompt(trimmed).startsWith('[AGY Cockpit Smart Handoff]');
}

function cleanModelPreview(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent
    .replace(/<HANDOFF_PROMPT>[\s\S]*?<\/HANDOFF_PROMPT>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[A-Za-z_][A-Za-z0-9_-]*>/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[-*>]\s+/gm, '')
    .replace(/[*_`~]+/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 300);
}

function normalizeSearchText(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildCenteredSearchSnippet(rawText, rawQuery, maxChars = 160) {
  if (!rawText || typeof rawText !== 'string') return '';
  const norm = rawText.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  const qLower = normalizeSearchText(rawQuery);
  const effectiveMax = Math.max(maxChars, qLower.length + 24);
  if (!qLower || norm.length <= effectiveMax) return norm;
  const lower = norm.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx < 0) return norm.slice(0, maxChars).trimEnd() + '…';

  const matchEnd = idx + qLower.length;
  const sideBudget = Math.max(0, Math.floor((effectiveMax - qLower.length) / 2));
  let start = Math.max(0, idx - sideBudget);
  let end = Math.min(norm.length, start + effectiveMax);
  if (end === norm.length) {
    start = Math.max(0, end - effectiveMax);
  }

  if (start > 0 && norm[start - 1] !== ' ') {
    const spaceAfter = norm.indexOf(' ', start);
    if (spaceAfter >= start && spaceAfter < idx && spaceAfter - start <= 16) {
      start = spaceAfter + 1;
    }
  }
  if (end < norm.length && norm[end] !== ' ') {
    const spaceBefore = norm.lastIndexOf(' ', end);
    if (spaceBefore >= matchEnd && end - spaceBefore <= 16) {
      end = spaceBefore;
    }
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < norm.length ? '…' : '';
  return prefix + norm.slice(start, end).trim() + suffix;
}

function classifyPollution(compactCount, compactedPrompts = 0) {
  if (compactCount <= 2 && compactedPrompts === 0) {
    return { id: 'fresh', label: 'Fresh', color: '#10b981' };
  }
  if (compactCount <= 5) {
    return { id: 'warm', label: 'Warm', color: '#eab308' };
  }
  if (compactCount <= 9) {
    return { id: 'heavy', label: 'Heavy', color: '#f97316' };
  }
  return { id: 'polluted', label: 'Polluted', color: '#ef4444' };
}

function computeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function extractCheckpointOverview(content) {
  if (!content || typeof content !== 'string') return '';
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(content);
  const body = summaryMatch ? summaryMatch[1] : content;
  const overviewMatch = /#+\s*(?:\d+\.\s*)?Task Overview\s*\n+([\s\S]*?)(?=\n---|\n#+\s|\n<\/summary>|$)/i.exec(body);
  const rawSection = overviewMatch
    ? overviewMatch[1]
    : (summaryMatch
      ? summaryMatch[1]
      : body.replace(/^# Resuming from a compaction\s*\n+(?:You are continuing work[^\n]*\n+)?/i, ''));
  return rawSection
    .replace(/<truncated\s+\d+\s+bytes>/gi, '[...]')
    .replace(/<\/?[A-Za-z_][A-Za-z0-9_-]*>/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, 4000);
}

const TRUNCATED_BYTES_RE = /<truncated\s+(\d+)\s+bytes>/gi;
const SKILL_PATH_RE = /\/skills\/([^/]+)\/(.+)$/i;

function estimateRawUtf8Bytes(str) {
  if (!str || typeof str !== 'string') return 0;
  let total = Buffer.byteLength(str, 'utf-8');
  if (str.includes('<truncated ')) {
    TRUNCATED_BYTES_RE.lastIndex = 0;
    let m;
    while ((m = TRUNCATED_BYTES_RE.exec(str)) !== null) {
      const extra = parseInt(m[1], 10);
      if (Number.isFinite(extra) && extra > 0) {
        total += extra;
      }
    }
  }
  return total;
}

function cleanTranscriptArgString(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string') return String(val);
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  if (s.startsWith('"')) {
    s = s.slice(1);
  }
  if (s.endsWith('"')) {
    s = s.slice(0, -1);
  }
  return s
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function estimateToolArgsBytes(args) {
  if (!args || typeof args !== 'object') return 0;
  let total = 0;
  for (const [k, v] of Object.entries(args)) {
    total += Buffer.byteLength(k, 'utf-8');
    if (typeof v === 'string') {
      total += estimateRawUtf8Bytes(cleanTranscriptArgString(v));
    } else if (v !== null && v !== undefined) {
      total += estimateRawUtf8Bytes(JSON.stringify(v));
    }
  }
  return total;
}

function extractToolFilePath(args) {
  if (!args || typeof args !== 'object') return '';
  const raw =
    args.Path ??
    args.AbsolutePath ??
    args.TargetFile ??
    args.DirectoryPath ??
    args.SearchPath ??
    args.SearchDirectory ??
    args.path ??
    '';
  const cleaned = cleanTranscriptArgString(raw).trim();
  if (!cleaned) return '';
  return cleaned.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

function extractSkillFromPath(normPath) {
  if (!normPath) return null;
  const m = SKILL_PATH_RE.exec(normPath);
  if (!m) return null;
  return {
    skillName: m[1],
    relFile: m[2]
  };
}

function formatToolStepTarget(toolName, args) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  const normPath = extractToolFilePath(safeArgs);

  if (toolName === 'read_file' || toolName === 'view_file') {
    const skillInfo = extractSkillFromPath(normPath);
    let label = skillInfo
      ? `${skillInfo.skillName}/${skillInfo.relFile}`
      : (normPath.split('/').filter(Boolean).pop() || normPath || toolName);
    const startLine = cleanTranscriptArgString(safeArgs.StartLine ?? safeArgs.start_line ?? '').trim();
    const endLine = cleanTranscriptArgString(safeArgs.EndLine ?? safeArgs.end_line ?? '').trim();
    if (startLine && endLine) {
      label += ` (L${startLine}-${endLine})`;
    } else if (startLine) {
      label += ` (L${startLine}+)`;
    } else if (endLine) {
      label += ` (L1-${endLine})`;
    }
    return label;
  }

  if (
    toolName === 'edit_file' ||
    toolName === 'write_file' ||
    toolName === 'replace_file_content' ||
    toolName === 'multi_replace_file_content' ||
    toolName === 'delete_file'
  ) {
    return normPath.split('/').filter(Boolean).pop() || normPath || toolName;
  }

  if (toolName === 'run_command') {
    const cmd = cleanTranscriptArgString(safeArgs.CommandLine ?? safeArgs.command ?? safeArgs.toolSummary ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cmd) return 'run_command';
    return cmd.length > 64 ? cmd.slice(0, 61) + '...' : cmd;
  }

  if (toolName === 'manage_task') {
    const act = cleanTranscriptArgString(safeArgs.Action ?? '').trim();
    const tid = cleanTranscriptArgString(safeArgs.TaskId ?? '').trim();
    return [act, tid].filter(Boolean).join(' ') || 'manage_task';
  }

  if (toolName === 'grep_search') {
    const q = cleanTranscriptArgString(safeArgs.Query ?? safeArgs.query ?? '').replace(/\s+/g, ' ').trim();
    const base = normPath ? normPath.split('/').filter(Boolean).pop() : '';
    const qPart = q ? `"${q.length > 36 ? q.slice(0, 33) + '...' : q}"` : 'grep';
    return base ? `${qPart} in ${base}` : qPart;
  }

  if (toolName === 'find_by_name' || toolName === 'list_dir') {
    const pat = cleanTranscriptArgString(safeArgs.Pattern ?? '').trim();
    const base = normPath ? normPath.split('/').filter(Boolean).pop() : '';
    return [pat, base].filter(Boolean).join(' in ') || normPath || toolName;
  }

  if (toolName === 'call_mcp_tool') {
    const srv = cleanTranscriptArgString(safeArgs.ServerName ?? '').trim();
    const tl = cleanTranscriptArgString(safeArgs.ToolName ?? '').trim();
    return [srv, tl].filter(Boolean).join(' / ') || 'call_mcp_tool';
  }

  if (toolName === 'invoke_subagent') {
    const role = cleanTranscriptArgString(safeArgs.Role ?? safeArgs.role ?? safeArgs.TypeName ?? safeArgs.type_name ?? '').trim();
    return role || 'subagent';
  }

  if (toolName === 'send_message') {
    const rec = cleanTranscriptArgString(safeArgs.Recipient ?? '').trim();
    return rec ? `to ${rec.slice(0, 8)}` : 'send_message';
  }

  if (toolName === 'search_web' || toolName === 'search_marketplace') {
    const q = cleanTranscriptArgString(safeArgs.query ?? safeArgs.queries ?? '').replace(/\s+/g, ' ').trim();
    return q ? (q.length > 50 ? q.slice(0, 47) + '...' : q) : toolName;
  }

  for (const val of Object.values(safeArgs)) {
    const cleaned = cleanTranscriptArgString(val).replace(/\s+/g, ' ').trim();
    if (cleaned) {
      return cleaned.length > 50 ? cleaned.slice(0, 47) + '...' : cleaned;
    }
  }
  return toolName;
}

function classifyToolCategory(toolName) {
  if (
    toolName === 'read_file' ||
    toolName === 'view_file' ||
    toolName === 'view_file_outline' ||
    toolName === 'view_code_item' ||
    toolName === 'grep_search' ||
    toolName === 'find_by_name' ||
    toolName === 'list_dir'
  ) {
    return 'file_reads_search';
  }
  if (
    toolName === 'run_command' ||
    toolName === 'manage_task' ||
    toolName === 'command_status' ||
    toolName === 'send_command_input' ||
    toolName === 'read_terminal' ||
    toolName === 'schedule'
  ) {
    return 'terminal_tasks';
  }
  if (
    toolName === 'edit_file' ||
    toolName === 'write_file' ||
    toolName === 'replace_file_content' ||
    toolName === 'multi_replace_file_content' ||
    toolName === 'delete_file'
  ) {
    return 'code_edits_writes';
  }
  return 'subagents_mcp';
}

function buildContextBreakdownForTranscript(convId, transcriptPath, entry, observedCeiling) {
  const categoriesMap = {
    file_reads_search: { id: 'file_reads_search', label: 'File Reads & Search', count: 0, bytes: 0, estTokens: 0 },
    terminal_tasks: { id: 'terminal_tasks', label: 'Terminal & Tasks', count: 0, bytes: 0, estTokens: 0 },
    code_edits_writes: { id: 'code_edits_writes', label: 'Code Edits & Writes', count: 0, bytes: 0, estTokens: 0 },
    subagents_mcp: { id: 'subagents_mcp', label: 'Subagents & MCP', count: 0, bytes: 0, estTokens: 0 }
  };

  const stepsByIdx = new Map();
  const unindexedSteps = [];

  if (transcriptPath && isFile(transcriptPath)) {
    try {
      const rawText = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = rawText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.length < 2) continue;
        try {
          const obj = JSON.parse(line);
          if (!obj || typeof obj !== 'object') continue;
          if (typeof obj.step_index === 'number') {
            const prev = stepsByIdx.get(obj.step_index);
            if (prev) {
              stepsByIdx.set(obj.step_index, {
                ...prev,
                ...obj,
                content: (typeof obj.content === 'string' && obj.content.length > 0)
                  ? obj.content
                  : (prev.content || ''),
                tool_calls: (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0)
                  ? obj.tool_calls
                  : (prev.tool_calls || []),
                input_tokens: (typeof obj.input_tokens === 'number' && obj.input_tokens > 0)
                  ? obj.input_tokens
                  : (prev.input_tokens || 0),
                cache_read_tokens: (typeof obj.cache_read_tokens === 'number' && obj.cache_read_tokens > 0)
                  ? obj.cache_read_tokens
                  : (prev.cache_read_tokens || 0),
                output_tokens: (typeof obj.output_tokens === 'number' && obj.output_tokens > 0)
                  ? obj.output_tokens
                  : (prev.output_tokens || 0)
              });
            } else {
              stepsByIdx.set(obj.step_index, obj);
            }
          } else {
            unindexedSteps.push(obj);
          }
        } catch {}
      }
    } catch {}
  }

  const steps = [
    ...[...stepsByIdx.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
    ...unindexedSteps
  ];
  let lastCheckpointIdx = -1;
  let totalCheckpoints = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === 'CHECKPOINT') {
      lastCheckpointIdx = i;
      totalCheckpoints += 1;
    }
  }

  const activeSkillsMap = new Map();
  const compactedSkillsMap = new Map();
  const activeToolSteps = [];
  const activeFilesMap = new Map();

  let firstPlannerTotal = 0;
  let firstPlannerCacheRead = 0;
  let lastPlannerTotal = 0;
  let activePromptsCount = 0;
  let activePlannerStepsCount = 0;
  let activeToolCallsCount = 0;
  let userMessagesBytes = 0;
  let assistantTextBytes = 0;
  let checkpointSummaryBytes = 0;

  if (lastCheckpointIdx >= 0 && steps[lastCheckpointIdx]) {
    checkpointSummaryBytes = estimateRawUtf8Bytes(steps[lastCheckpointIdx].content || '');
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = step.type || '';
    const isActive = i > lastCheckpointIdx;
    const content = typeof step.content === 'string' ? step.content : '';

    if (isActive && type === 'USER_INPUT') {
      const cleaned = cleanUserPrompt(content);
      if (cleaned && !isSmartHandoffRequestText(cleaned)) {
        activePromptsCount += 1;
        userMessagesBytes += estimateRawUtf8Bytes(cleaned);
      }
      continue;
    }

    if (isActive && type === 'SYSTEM_MESSAGE' && i > 0) {
      const sysBytes = estimateRawUtf8Bytes(content);
      if (sysBytes > 0) {
        const isSubagentMsg = SENDER_UUID_RE.test(content);
        const catKey = isSubagentMsg ? 'subagents_mcp' : 'terminal_tasks';
        categoriesMap[catKey].count += 1;
        categoriesMap[catKey].bytes += sysBytes;
      }
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];

      if (isActive) {
        activePlannerStepsCount += 1;
        if (content) {
          assistantTextBytes += estimateRawUtf8Bytes(content);
        }
        const inTok = typeof step.input_tokens === 'number' && step.input_tokens > 0 ? step.input_tokens : 0;
        const cacheTok = typeof step.cache_read_tokens === 'number' && step.cache_read_tokens > 0 ? step.cache_read_tokens : 0;
        const stepTotalTok = inTok + cacheTok;
        if (stepTotalTok > 0) {
          if (firstPlannerTotal === 0) {
            firstPlannerTotal = stepTotalTok;
            firstPlannerCacheRead = cacheTok;
          }
          lastPlannerTotal = stepTotalTok;
        }
      }

      if (toolCalls.length === 0) continue;

      const turnGenerics = [];
      for (let j = i + 1; j < steps.length; j++) {
        const nextType = steps[j].type || '';
        if (nextType === 'PLANNER_RESPONSE' || nextType === 'CHECKPOINT' || nextType === 'USER_INPUT') {
          break;
        }
        if (nextType === 'GENERIC') {
          turnGenerics.push(steps[j]);
        }
      }

      let filteredGenerics = turnGenerics;
      let extraSubagentBytes = 0;
      if (turnGenerics.length > toolCalls.length) {
        filteredGenerics = [];
        for (const g of turnGenerics) {
          const gc = typeof g.content === 'string' ? g.content : '';
          if (
            gc.startsWith('Created the following subagent') &&
            turnGenerics.length - filteredGenerics.length > toolCalls.length - filteredGenerics.length
          ) {
            extraSubagentBytes += estimateRawUtf8Bytes(gc);
          } else {
            filteredGenerics.push(g);
          }
        }
      }

      for (let k = 0; k < toolCalls.length; k++) {
        const tc = toolCalls[k];
        if (!tc || typeof tc !== 'object') continue;
        const toolName = typeof tc.name === 'string' && tc.name.trim() ? tc.name.trim() : 'unknown';
        const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
        const matchedGeneric = k < filteredGenerics.length ? filteredGenerics[k] : null;

        const argBytes = estimateToolArgsBytes(args);
        let outputBytes = matchedGeneric ? estimateRawUtf8Bytes(matchedGeneric.content || '') : 0;
        if (toolName === 'invoke_subagent' && extraSubagentBytes > 0) {
          outputBytes += extraSubagentBytes;
          extraSubagentBytes = 0;
        }
        const totalBytes = argBytes + outputBytes;
        const normPath = extractToolFilePath(args);
        const skillInfo =
          (toolName === 'read_file' || toolName === 'view_file')
            ? extractSkillFromPath(normPath)
            : null;

        if (skillInfo) {
          const targetMap = isActive ? activeSkillsMap : compactedSkillsMap;
          const existingSkill = targetMap.get(skillInfo.skillName);
          if (existingSkill) {
            existingSkill.count += 1;
            existingSkill.bytes += totalBytes;
            if (!existingSkill.files.includes(skillInfo.relFile)) {
              existingSkill.files.push(skillInfo.relFile);
            }
          } else {
            targetMap.set(skillInfo.skillName, {
              name: skillInfo.skillName,
              files: [skillInfo.relFile],
              count: 1,
              bytes: totalBytes,
              estTokens: 0
            });
          }
        }

        if (!isActive) continue;

        activeToolCallsCount += 1;

        if (!skillInfo) {
          const catId = classifyToolCategory(toolName);
          categoriesMap[catId].count += 1;
          categoriesMap[catId].bytes += totalBytes;
        }

        const target = formatToolStepTarget(toolName, args);
        activeToolSteps.push({
          stepIndex: typeof step.step_index === 'number' ? step.step_index : i,
          tool: toolName,
          target,
          bytes: totalBytes,
          argBytes,
          outputBytes,
          estTokens: Math.round(totalBytes / 4)
        });

        const isReadTool = toolName === 'read_file' || toolName === 'view_file';
        const isEditTool =
          toolName === 'edit_file' ||
          toolName === 'write_file' ||
          toolName === 'replace_file_content' ||
          toolName === 'multi_replace_file_content';

        if (!skillInfo && normPath && (isReadTool || isEditTool)) {
          const fileKey = workspaceComparisonKey(normPath);
          const parts = normPath.split('/').filter(Boolean);
          const label = parts.length >= 2
            ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
            : (parts[parts.length - 1] || normPath);
          const existingFile = activeFilesMap.get(fileKey);
          if (existingFile) {
            if (isReadTool) existingFile.readCount += 1;
            if (isEditTool) existingFile.editCount += 1;
            existingFile.totalCount += 1;
            existingFile.bytes += totalBytes;
          } else {
            activeFilesMap.set(fileKey, {
              path: normPath,
              label,
              readCount: isReadTool ? 1 : 0,
              editCount: isEditTool ? 1 : 0,
              totalCount: 1,
              bytes: totalBytes,
              estTokens: 0
            });
          }
        }
      }
    }
  }

  const effectiveCompactCount = Math.max(totalCheckpoints, (entry && entry.compactCount) || 0);
  const currentTokens = lastPlannerTotal > 0 ? lastPlannerTotal : ((entry && entry.currentTokens) || 0);
  let baseTokens = firstPlannerTotal > 0
    ? firstPlannerTotal
    : (currentTokens > 0 ? currentTokens : ((entry && entry.baseContextTokens) || 0));
  if (currentTokens > 0 && baseTokens > currentTokens) {
    baseTokens = currentTokens;
  }
  const activeGrowthTokens = Math.max(0, currentTokens - baseTokens);
  const ceiling = observedCeiling || 0;
  const ceilingExceeded = ceiling > 0 && currentTokens > ceiling;
  const contextRatio = ceiling > 0 && !ceilingExceeded ? Math.min(1, currentTokens / ceiling) : null;

  const activeSkills = [...activeSkillsMap.values()]
    .map((s) => ({ ...s, estTokens: Math.round(s.bytes / 4) }))
    .sort((a, b) => b.bytes - a.bytes);

  const compactedSkills = [...compactedSkillsMap.values()]
    .map((s) => ({ ...s, estTokens: Math.round(s.bytes / 4) }))
    .sort((a, b) => b.bytes - a.bytes);

  const categories = Object.values(categoriesMap).map((c) => ({
    ...c,
    estTokens: Math.round(c.bytes / 4)
  }));

  const heaviestSteps = activeToolSteps
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  const topFiles = [...activeFilesMap.values()]
    .map((f) => ({ ...f, estTokens: Math.round(f.bytes / 4) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  return {
    id: convId,
    compactCount: effectiveCompactCount,
    lastCompactMs: (entry && entry.lastCompactMs) || 0,
    currentTokens,
    observedCeiling: ceiling,
    ceilingExceeded,
    contextRatio,
    baseTokens,
    cachedSystemPrefixTokens: firstPlannerCacheRead,
    activeGrowthTokens,
    checkpointSummaryBytes,
    checkpointSummaryEstTokens: Math.round(checkpointSummaryBytes / 4),
    activePromptsCount,
    activePlannerStepsCount,
    activeToolCallsCount,
    userMessagesBytes,
    assistantTextBytes,
    activeSkills,
    compactedSkills,
    categories,
    heaviestSteps,
    topFiles
  };
}

function extractPathsFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const results = [];
  const pathKeys = [
    'Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath',
    'SearchPath', 'SearchDirectory', 'Cwd', 'path', 'cwd'
  ];
  for (const tc of toolCalls) {
    const args = tc && typeof tc.args === 'object' && tc.args ? tc.args : null;
    if (!args) continue;
    for (const key of pathKeys) {
      if (typeof args[key] === 'string' && args[key].length > 2) {
        results.push(cleanTranscriptArgString(args[key]));
      }
    }
    if (typeof args.CommandLine === 'string') {
      const cleanedCmd = cleanTranscriptArgString(args.CommandLine);
      const manifestMatch = /--manifest-path\s+["']?([^"'\s]+)["']?/i.exec(cleanedCmd);
      if (manifestMatch) results.push(manifestMatch[1]);
    }
  }
  return results;
}

function createEmptyEntry(convId) {
  const entry = {
    id: convId,
    mtimeMs: 0,
    size: 0,
    parsedBytes: 0,
    lastLineOffset: 0,
    lastParsedStepIndex: -1,
    lastPlannerStepTok: null,
    lastHandoffRequestStepIndex: -1,
    lastHandoffStepIndex: -1,
    lastHandoffCompletedStepIndex: -1,
    handoffRpcPendingMs: 0,
    lastActiveIso: '',
    lastActiveMs: 0,
    lastUserInputMs: 0,
    lastViewMs: 0,
    lastSeenMs: 0,
    manualUnreadAtMs: 0,
    archived: false,
    markedAsUnread: false,
    isSubagent: false,
    parentConvId: '',
    spawnedSubagentIds: [],
    subagentRoles: {},
    compactCount: 0,
    lastCompactMs: 0,
    promptsSinceLastCompact: 0,
    promptCount: 0,
    currentTokens: 0,
    lastPlannerTokens: 0,
    baseContextTokens: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    compactTriggerTokens: [],
    projectId: '',
    workspacePath: '',
    workspaceCounts: {},
    lsSummary: '',
    title: '',
    firstPrompt: '',
    lastPrompt: '',
    lastModelResponse: '',
    lastModelResponseMs: 0,
    lastStepType: '',
    lastStepStatus: '',
    lastStepHasToolCalls: false,
    lastStepIsCompletedReply: false,
    lastStepWaitKind: '',
    lastStepWaitDelayMs: 0,
    lastStepWaitToolName: '',
    lastStepMs: 0,
    latestHandoffPrompt: '',
    latestHandoffMs: 0,
    handoffPendingMs: 0,
    handoffTargetStepIndex: -1,
    awaitingHandoffResponse: false,
    needsFullHandoffRead: false,
    checkpointTargetStepIndex: -1,
    needsFullCheckpointRead: false,
    checkpointOverview: '',
    modelEnum: '',
    modelLabel: '',
    modelResolvedMtimeMs: 0,
    prompts: [],
    mentionedCommits: []
  };
  Object.defineProperty(entry, 'searchCorpusLower', {
    value: '',
    writable: true,
    enumerable: false,
    configurable: true
  });
  return entry;
}

function classifyToolCallsWait(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { kind: '', delayMs: 0, toolName: '' };
  }
  let hasPermissionTool = false;
  let maxPermissionDelayMs = 0;
  let permissionToolName = '';

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const name = typeof tc.name === 'string' ? tc.name.trim() : '';
    const args = tc.args && typeof tc.args === 'object' ? tc.args : {};

    if (name === 'ask_question' || name === 'ask_user' || name === 'ask_followup_question') {
      return { kind: 'question', delayMs: 0, toolName: name };
    }
    if (name === 'ask_custom_permission' || name.includes('permission')) {
      return { kind: 'permission', delayMs: 0, toolName: name };
    }
    if (name === 'run_command') {
      // Antigravity writes PLANNER_RESPONSE when a tool call is emitted, and only writes
      // the next GENERIC step when the command finishes or hits WaitMsBeforeAsync and gets
      // backgrounded. Even BypassSandbox: true commands can be auto-approved via Always Allow
      // and run for up to WaitMsBeforeAsync, whereas commands genuinely awaiting user approval
      // do not start the WaitMsBeforeAsync timer until the user clicks Allow.
      const rawWait = parseInt(String(args.WaitMsBeforeAsync ?? '').replace(/^["'\s]+|["'\s]+$/g, ''), 10);
      const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(Math.max(rawWait, 500), 15000) : 5000;
      hasPermissionTool = true;
      if (!permissionToolName || waitMs + 3000 >= maxPermissionDelayMs) {
        permissionToolName = name;
      }
      maxPermissionDelayMs = Math.max(maxPermissionDelayMs, waitMs + 3000);
      continue;
    }
    if (
      name === 'read_file' ||
      name === 'write_file' ||
      name === 'edit_file' ||
      name === 'view_file' ||
      name === 'list_dir' ||
      name === 'delete_file'
    ) {
      hasPermissionTool = true;
      if (!permissionToolName) permissionToolName = name;
      maxPermissionDelayMs = Math.max(maxPermissionDelayMs, 5000);
    }
  }

  return hasPermissionTool
    ? { kind: 'permission', delayMs: maxPermissionDelayMs, toolName: permissionToolName }
    : { kind: '', delayMs: 0, toolName: '' };
}

function getEntryWaitState(entry, nowMs = Date.now()) {
  if (!entry || entry.lastStepStatus === 'CANCELED') return '';
  if (entry.lastStepType !== 'PLANNER_RESPONSE' || !entry.lastStepHasToolCalls) return '';
  const kind = entry.lastStepWaitKind || '';
  if (kind !== 'permission' && kind !== 'question') return '';
  const lastAct = Math.max(entry.mtimeMs || 0, entry.lastStepMs || 0, entry.lastActiveMs || 0);
  if (!lastAct) return '';
  const elapsed = nowMs - lastAct;
  if (elapsed > 12 * 60 * 60 * 1000) return '';
  const delayMs = typeof entry.lastStepWaitDelayMs === 'number' ? entry.lastStepWaitDelayMs : 0;
  if (elapsed < delayMs) return '';
  return kind;
}

function isEntryThinking(entry, nowMs = Date.now()) {
  if (!entry || entry.lastStepStatus === 'CANCELED') return false;
  if (getEntryWaitState(entry, nowMs)) return false;
  if (entry.handoffRpcPendingMs && nowMs - entry.handoffRpcPendingMs < 30000) return true;
  const lastAct = Math.max(entry.mtimeMs || 0, entry.lastStepMs || 0, entry.lastActiveMs || 0);
  if (!lastAct || nowMs - lastAct > 180000) return false;
  if (entry.awaitingHandoffResponse) return true;
  if (entry.lastStepStatus === 'RUNNING') return true;
  if (
    entry.lastStepType === 'USER_INPUT' ||
    entry.lastStepType === 'GENERIC' ||
    entry.lastStepType === 'SYSTEM_MESSAGE'
  ) {
    return true;
  }
  if (entry.lastStepType === 'PLANNER_RESPONSE' && entry.lastStepHasToolCalls) return true;
  return false;
}

function extractMentionedCommits(entry, text) {
  let commitMatch;
  GIT_COMMIT_OUT_RE.lastIndex = 0;
  while ((commitMatch = GIT_COMMIT_OUT_RE.exec(text)) !== null) {
    const sha7 = commitMatch[1].slice(0, 7).toLowerCase();
    if (!entry.mentionedCommits.includes(sha7)) {
      entry.mentionedCommits.push(sha7);
    }
  }
}

function processTranscriptLine(entry, line, isFirstLine) {
  if (!line || line.length < 2) return false;

  const hasUser = line.includes('"type":"USER_INPUT"');
  const hasPlanner = line.includes('"type":"PLANNER_RESPONSE"');
  const hasCheckpoint = line.includes('"type":"CHECKPOINT"');
  const hasSystem = line.includes('"type":"SYSTEM_MESSAGE"');
  const hasGeneric =
    !hasUser && !hasPlanner && !hasCheckpoint && !hasSystem && line.includes('"type":"GENERIC"');
  const hasError =
    !hasUser && !hasPlanner && !hasCheckpoint && !hasSystem && !hasGeneric && line.includes('"type":"ERROR_MESSAGE"');
  const hasSubagentCreation = hasGeneric && line.includes('Created the following subagent');

  if (hasGeneric && !hasSubagentCreation) {
    entry.lastStepType = 'GENERIC';
    entry.lastStepStatus = line.includes('"status":"RUNNING"')
      ? 'RUNNING'
      : (line.includes('"status":"ERROR"') ? 'ERROR' : 'DONE');
    entry.lastStepHasToolCalls = false;
    entry.lastStepIsCompletedReply = false;
    entry.lastStepWaitKind = '';
    entry.lastStepWaitDelayMs = 0;
    entry.lastStepWaitToolName = '';
    const tsMatch = /"created_at"\s*:\s*"([^"]+)"/.exec(line);
    if (tsMatch) {
      const tsMs = Date.parse(tsMatch[1]);
      if (tsMs > 0) {
        entry.lastStepMs = Math.max(entry.lastStepMs || 0, tsMs);
        if (tsMs >= (entry.lastActiveMs || 0)) {
          entry.lastActiveIso = tsMatch[1];
          entry.lastActiveMs = tsMs;
        }
      }
    }
    if (line.includes('[')) {
      extractMentionedCommits(entry, line);
    }
    return false;
  }

  if (hasError) {
    entry.lastStepType = 'ERROR_MESSAGE';
    entry.lastStepStatus = 'ERROR';
    entry.lastStepHasToolCalls = false;
    entry.lastStepIsCompletedReply = false;
    entry.lastStepWaitKind = '';
    entry.lastStepWaitDelayMs = 0;
    entry.lastStepWaitToolName = '';
    return false;
  }

  if (!hasUser && !hasPlanner && !hasCheckpoint && !hasSystem && !hasGeneric && !isFirstLine) {
    return false;
  }

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }

  const stepIdx = typeof obj.step_index === 'number' ? obj.step_index : -1;
  const isRepeatStep = stepIdx >= 0 && stepIdx === entry.lastParsedStepIndex;

  const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
  const createdMs = createdAt ? Date.parse(createdAt) : 0;

  const type = obj.type || '';
  const content = typeof obj.content === 'string' ? obj.content : '';

  if (
    !entry.isSubagent &&
    entry.promptCount === 0 &&
    (type === 'SYSTEM_MESSAGE' || (isFirstLine && content.startsWith('The following is a <SYSTEM_MESSAGE>')))
  ) {
    const senderMatch = SENDER_UUID_RE.exec(content);
    if (senderMatch) {
      entry.isSubagent = true;
      entry.parentConvId = senderMatch[1].toLowerCase();
      if (!entry.firstPrompt) {
        const cleanedSys = cleanUserPrompt(content);
        if (cleanedSys) {
          entry.firstPrompt = cleanedSys.slice(0, 500);
          entry.lastPrompt = entry.firstPrompt;
        }
      }
    }
  }

  if (type === 'USER_INPUT') {
    const clean = cleanUserPrompt(content);
    if (clean) {
      if (isSmartHandoffRequestText(clean)) {
        if (stepIdx >= 0) {
          entry.lastParsedStepIndex = stepIdx;
          entry.lastHandoffRequestStepIndex = stepIdx;
        } else if (typeof entry.lastParsedStepIndex === 'number' && entry.lastParsedStepIndex >= 0) {
          entry.lastHandoffRequestStepIndex = entry.lastParsedStepIndex;
        }
        if (createdMs > 0) {
          entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
        }
        entry.lastStepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
        entry.lastStepHasToolCalls = false;
        entry.lastStepIsCompletedReply = false;
        entry.lastStepWaitKind = '';
        entry.lastStepWaitDelayMs = 0;
        entry.lastStepWaitToolName = '';
        entry.lastHandoffStepIndex = -1;
        entry.handoffTargetStepIndex = -1;
        entry.needsFullHandoffRead = false;
        entry.handoffRpcPendingMs = 0;
        entry.awaitingHandoffResponse = true;
        return false;
      }
      if (createdAt && createdMs >= entry.lastActiveMs) {
        entry.lastActiveIso = createdAt;
        entry.lastActiveMs = createdMs;
      }
      if (!entry.isSubagent && obj.source !== 'SYSTEM' && createdMs >= (entry.lastUserInputMs || 0)) {
        entry.lastUserInputMs = createdMs;
      }
      entry.lastStepType = 'USER_INPUT';
      entry.lastStepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
      entry.lastStepHasToolCalls = false;
      entry.lastStepIsCompletedReply = false;
      entry.lastStepWaitKind = '';
      entry.lastStepWaitDelayMs = 0;
      entry.lastStepWaitToolName = '';
      if (createdMs > 0) {
        entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
      }
      entry.awaitingHandoffResponse = false;
      entry.handoffRpcPendingMs = 0;
      entry.lastHandoffStepIndex = -1;
      entry.needsFullHandoffRead = false;
      entry.handoffTargetStepIndex = -1;
      if (!isRepeatStep) {
        if (stepIdx >= 0) entry.lastParsedStepIndex = stepIdx;
        entry.promptCount += 1;
        entry.promptsSinceLastCompact += 1;
        if (!entry.firstPrompt) entry.firstPrompt = clean.slice(0, 500);
        entry.lastPrompt = clean.slice(0, 500);
        entry.prompts.push({
          index: entry.promptCount,
          createdAt,
          text: clean.slice(0, 4000)
        });
        if (entry.prompts.length > 60) {
          entry.prompts.splice(0, entry.prompts.length - 60);
        }
        return true;
      }
      return false;
    }
    return false;
  }

  if (type === 'PLANNER_RESPONSE') {
    if (createdAt && createdMs >= entry.lastActiveMs) {
      entry.lastActiveIso = createdAt;
      entry.lastActiveMs = createdMs;
    }
    const hasTools = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
    const prevHadTools = isRepeatStep && Boolean(entry.lastStepHasToolCalls);
    const stepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
    const isAfterHandoffRequest =
      stepIdx < 0 ||
      typeof entry.lastHandoffRequestStepIndex !== 'number' ||
      entry.lastHandoffRequestStepIndex < 0 ||
      stepIdx > entry.lastHandoffRequestStepIndex;
    if (hasTools) {
      if (entry.lastHandoffStepIndex === stepIdx) {
        entry.lastHandoffStepIndex = -1;
      }
    } else if (entry.awaitingHandoffResponse && isAfterHandoffRequest && stepIdx >= 0) {
      entry.lastHandoffStepIndex = stepIdx;
    }
    const wasAwaitingHandoff = Boolean(
      isAfterHandoffRequest &&
      (entry.awaitingHandoffResponse || (stepIdx >= 0 && entry.lastHandoffStepIndex === stepIdx))
    );
    const waitSpec = hasTools ? classifyToolCallsWait(obj.tool_calls) : { kind: '', delayMs: 0, toolName: '' };
    entry.lastStepType = 'PLANNER_RESPONSE';
    entry.lastStepStatus = stepStatus;
    entry.lastStepHasToolCalls = hasTools;
    entry.lastStepWaitKind = waitSpec.kind;
    entry.lastStepWaitDelayMs = waitSpec.delayMs;
    entry.lastStepWaitToolName = waitSpec.toolName || '';
    if (createdMs > 0) {
      entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
    }

    const inTok = typeof obj.input_tokens === 'number' && obj.input_tokens > 0 ? obj.input_tokens : 0;
    const cacheTok = typeof obj.cache_read_tokens === 'number' && obj.cache_read_tokens > 0 ? obj.cache_read_tokens : 0;
    const outTok = typeof obj.output_tokens === 'number' && obj.output_tokens > 0 ? obj.output_tokens : 0;
    const totalTok = inTok + cacheTok;
    if (totalTok > 0) {
      if (!entry.baseContextTokens) {
        const firstPromptTok = entry.firstPrompt ? Math.round(entry.firstPrompt.length / 4) : 0;
        entry.baseContextTokens = Math.max(4000, totalTok - firstPromptTok);
      }
      entry.lastPlannerTokens = totalTok;
      entry.currentTokens = totalTok;
    }
    const prevTok = (isRepeatStep && entry.lastPlannerStepTok)
      ? entry.lastPlannerStepTok
      : { inTok: 0, cacheTok: 0, outTok: 0 };
    const effInTok = inTok > 0 ? inTok : prevTok.inTok;
    const effCacheTok = cacheTok > 0 ? cacheTok : prevTok.cacheTok;
    const effOutTok = outTok > 0 ? outTok : prevTok.outTok;
    const deltaIn = effInTok - prevTok.inTok;
    const deltaCache = effCacheTok - prevTok.cacheTok;
    const deltaOut = effOutTok - prevTok.outTok;
    if (deltaIn !== 0 || deltaCache !== 0 || deltaOut !== 0) {
      entry.totalInputTokens = Math.max(0, (entry.totalInputTokens || 0) + deltaIn);
      entry.totalCacheReadTokens = Math.max(0, (entry.totalCacheReadTokens || 0) + deltaCache);
      entry.totalOutputTokens = Math.max(0, (entry.totalOutputTokens || 0) + deltaOut);
      entry.totalTokens = entry.totalInputTokens + entry.totalCacheReadTokens + entry.totalOutputTokens;
    }
    entry.lastPlannerStepTok = { inTok: effInTok, cacheTok: effCacheTok, outTok: effOutTok };

    let isHandoffStep = false;
    if (content && content.trim()) {
      const trimmedContent = content.trim();
      const isTruncatedContent =
        (Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('content')) ||
        content.includes('\n<truncated ');
      const handoffMatch = /<HANDOFF_PROMPT>\s*([\s\S]*?)\s*<\/HANDOFF_PROMPT>/i.exec(trimmedContent);
      const canUseStepForHandoff =
        stepStatus !== 'RUNNING' &&
        (stepIdx < 0 ||
          typeof entry.lastHandoffCompletedStepIndex !== 'number' ||
          stepIdx >= entry.lastHandoffCompletedStepIndex);
      const extractedHandoff = (!isTruncatedContent && canUseStepForHandoff)
        ? (handoffMatch && handoffMatch[1].trim()
            ? handoffMatch[1].trim()
            : (wasAwaitingHandoff && !/<HANDOFF_PROMPT>/i.test(trimmedContent) && !hasTools
                ? trimmedContent
                : ''))
        : '';
      if (extractedHandoff) {
        isHandoffStep = true;
        if (extractedHandoff !== entry.latestHandoffPrompt || entry.lastHandoffCompletedStepIndex !== stepIdx) {
          entry.latestHandoffPrompt = extractedHandoff;
          entry.latestHandoffMs = Math.max(createdMs || Date.now(), (entry.latestHandoffMs || 0) + 1);
          entry.lastHandoffCompletedStepIndex = stepIdx;
        }
        entry.awaitingHandoffResponse = false;
        entry.handoffRpcPendingMs = 0;
        entry.needsFullHandoffRead = false;
        entry.handoffTargetStepIndex = -1;
      } else if (
        isTruncatedContent &&
        canUseStepForHandoff &&
        (/<HANDOFF_PROMPT>/i.test(trimmedContent) || (wasAwaitingHandoff && !hasTools))
      ) {
        isHandoffStep = true;
        if (entry.lastHandoffCompletedStepIndex !== stepIdx || entry.needsFullHandoffRead) {
          entry.needsFullHandoffRead = true;
          entry.handoffTargetStepIndex = stepIdx;
          entry.handoffPendingMs = Math.max(createdMs || Date.now(), (entry.latestHandoffMs || 0) + 1);
        }
        entry.awaitingHandoffResponse = false;
        entry.handoffRpcPendingMs = 0;
      } else if (/<HANDOFF_PROMPT>/i.test(trimmedContent)) {
        isHandoffStep = true;
      } else if (!wasAwaitingHandoff) {
        const preview = cleanModelPreview(trimmedContent);
        if (preview) {
          entry.lastModelResponse = preview;
        }
      }
    }

    const isCompletedReply = Boolean(
      !isHandoffStep &&
      !wasAwaitingHandoff &&
      !hasTools &&
      stepStatus !== 'RUNNING' &&
      stepStatus !== 'CANCELED' &&
      stepStatus !== 'ERROR' &&
      (entry.promptCount > 0 || entry.lastModelResponse)
    );
    entry.lastStepIsCompletedReply = isCompletedReply;
    if (isCompletedReply) {
      const respTs = createdMs || entry.lastActiveMs || 0;
      if (respTs > 0) {
        entry.lastModelResponseMs = Math.max(entry.lastModelResponseMs || 0, respTs);
      }
    }

    entry.pendingSubagentRoles = [];
    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        if (tc && tc.name === 'invoke_subagent' && tc.args && typeof tc.args === 'object') {
          const role = tc.args.Role || tc.args.role || tc.args.TypeName || tc.args.type_name || '';
          entry.pendingSubagentRoles.push(typeof role === 'string' ? cleanTranscriptArgString(role).trim() : '');
        }
      }
    }
    if (stepIdx >= 0) entry.lastParsedStepIndex = stepIdx;
    return false;
  }

  if (type === 'CHECKPOINT') {
    if (isRepeatStep) return false;
    if (stepIdx >= 0) entry.lastParsedStepIndex = stepIdx;
    entry.lastStepIsCompletedReply = false;
    entry.compactCount += 1;
    entry.promptsSinceLastCompact = 0;
    if (entry.lastPlannerTokens > 0) {
      entry.compactTriggerTokens.push(entry.lastPlannerTokens);
      if (entry.compactTriggerTokens.length > 25) {
        entry.compactTriggerTokens.shift();
      }
    }
    if (createdAt) {
      entry.lastCompactMs = createdMs || entry.lastActiveMs;
    }
    if (createdAt && createdMs >= entry.lastActiveMs) {
      entry.lastActiveIso = createdAt;
      entry.lastActiveMs = createdMs;
    }
    const truncMatch = /<truncated\s+(\d+)\s+bytes>/i.exec(content);
    const extraBytes = truncMatch ? (parseInt(truncMatch[1], 10) || 0) : 0;
    const summaryTokens = Math.max(500, Math.round((content.length + extraBytes) / 4));
    const baseTok = entry.baseContextTokens > 0 ? entry.baseContextTokens : 21000;
    const estimatedPostCompact = baseTok + summaryTokens;
    entry.currentTokens = entry.lastPlannerTokens > 0
      ? Math.min(entry.lastPlannerTokens, estimatedPostCompact)
      : estimatedPostCompact;
    const isTruncatedContent =
      (Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('content')) ||
      content.includes('\n<truncated ');
    if (isTruncatedContent) {
      entry.needsFullCheckpointRead = true;
      entry.checkpointTargetStepIndex = stepIdx;
    } else {
      entry.needsFullCheckpointRead = false;
      entry.checkpointTargetStepIndex = -1;
    }
    const overview = extractCheckpointOverview(content);
    if (overview) {
      entry.checkpointOverview = overview;
      return true;
    }
    return false;
  }

  if (type === 'GENERIC' || type === 'SYSTEM_MESSAGE') {
    entry.lastStepType = type === 'GENERIC' ? 'GENERIC' : 'SYSTEM_MESSAGE';
    entry.lastStepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
    entry.lastStepHasToolCalls = false;
    entry.lastStepIsCompletedReply = false;
    entry.lastStepWaitKind = '';
    entry.lastStepWaitDelayMs = 0;
    entry.lastStepWaitToolName = '';
    if (createdMs > 0) {
      entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
    }
    if (type === 'GENERIC' && hasSubagentCreation) {
      const m = CHILD_CONV_RE.exec(content);
      const role = (!isRepeatStep && Array.isArray(entry.pendingSubagentRoles))
        ? entry.pendingSubagentRoles.shift()
        : '';
      if (m && UUID_RE.test(m[1])) {
        const childId = m[1].toLowerCase();
        if (childId !== entry.id && !entry.spawnedSubagentIds.includes(childId)) {
          entry.spawnedSubagentIds.push(childId);
        }
        if (role) {
          (entry.subagentRoles || (entry.subagentRoles = {}))[childId] = role;
        }
      }
    } else if (type === 'SYSTEM_MESSAGE' && !entry.isSubagent) {
      const m = SENDER_UUID_RE.exec(content);
      if (m && UUID_RE.test(m[1])) {
        const childId = m[1].toLowerCase();
        if (childId !== entry.id && !entry.spawnedSubagentIds.includes(childId)) {
          entry.spawnedSubagentIds.push(childId);
        }
      }
    }
    if (content.includes('[')) {
      extractMentionedCommits(entry, content);
    }
    if (stepIdx >= 0) entry.lastParsedStepIndex = stepIdx;
  }
  return false;
}

function decodePbtxtString(escaped) {
  if (!escaped) return '';
  const bytes = [];
  let i = 0;
  while (i < escaped.length) {
    if (escaped[i] === '\\' && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (next >= '0' && next <= '7') {
        let oct = next;
        let step = 2;
        if (i + 2 < escaped.length && escaped[i + 2] >= '0' && escaped[i + 2] <= '7') {
          oct += escaped[i + 2];
          step += 1;
          if (i + 3 < escaped.length && escaped[i + 3] >= '0' && escaped[i + 3] <= '7') {
            oct += escaped[i + 3];
            step += 1;
          }
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += step;
        continue;
      }
      if (next === 'n') bytes.push(10);
      else if (next === 'r') bytes.push(13);
      else if (next === 't') bytes.push(9);
      else if (next === '"' || next === '\'' || next === '\\') bytes.push(next.charCodeAt(0));
      else bytes.push(...Buffer.from(next, 'utf-8'));
      i += 2;
      continue;
    }
    const codePoint = escaped.codePointAt(i);
    const charStr = String.fromCodePoint(codePoint);
    bytes.push(...Buffer.from(charStr, 'utf-8'));
    i += charStr.length;
  }
  return Buffer.from(bytes).toString('utf-8').trim();
}

function encodePbtxtString(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function extractTitleFromPbtxt(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const match = /\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!match) return '';
  return decodePbtxtString(match[1]);
}

function extractAnnotationFromPbtxt(raw) {
  if (!raw || typeof raw !== 'string') {
    return { title: '', lastViewMs: 0, archived: false, markedAsUnread: false };
  }
  const title = extractTitleFromPbtxt(raw);
  const viewMatch = /\blast_user_view_time\s*:?\s*\{\s*seconds\s*:\s*(\d+)(?:\s+nanos\s*:\s*(\d+))?\s*\}/.exec(raw);
  let lastViewMs = 0;
  if (viewMatch) {
    const sec = parseInt(viewMatch[1], 10) || 0;
    const nanos = viewMatch[2] ? (parseInt(viewMatch[2], 10) || 0) : 0;
    if (sec > 0) {
      lastViewMs = sec * 1000 + Math.floor(nanos / 1e6);
    }
  }
  const archived = /\barchived\s*:\s*true\b/i.test(raw);
  const markedAsUnread = /\bmarked_as_unread\s*:\s*true\b/i.test(raw);
  return { title, lastViewMs, archived, markedAsUnread };
}

function rebuildSearchCorpus(entry) {
  const parts = [];
  if (entry.title) parts.push(normalizeSearchText(entry.title));
  if (entry.firstPrompt) parts.push(normalizeSearchText(entry.firstPrompt));
  if (entry.lastPrompt) parts.push(normalizeSearchText(entry.lastPrompt));
  if (entry.checkpointOverview) parts.push(normalizeSearchText(entry.checkpointOverview));
  for (const p of entry.prompts) {
    parts.push(normalizeSearchText(p.text));
  }
  Object.defineProperty(entry, 'searchCorpusLower', {
    value: parts.join('\n'),
    writable: true,
    enumerable: false,
    configurable: true
  });
}

const REFLOG_ACTION_RE = /^(?:commit(?:\s*\([^)]+\))?:|merge\b|pull\b|cherry-pick\b|rebase(?:\s*\((?!start\b|finish\b|abort\b)[^)]+\))?:)/i;
const CHECKPOINT_TOKEN = Buffer.from('"type":"CHECKPOINT"');

function resolveFullCheckpointOverview(entry, transcriptPath) {
  if (!entry.needsFullCheckpointRead) return false;
  entry.needsFullCheckpointRead = false;
  const targetStep = typeof entry.checkpointTargetStepIndex === 'number' ? entry.checkpointTargetStepIndex : -1;
  entry.checkpointTargetStepIndex = -1;

  const fullPath = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  if (!isFile(fullPath)) return false;

  let fullFd;
  try {
    const fStat = fs.statSync(fullPath);
    if (fStat.size <= 0) return false;
    fullFd = fs.openSync(fullPath, 'r');

    const windowSize = 2 * 1024 * 1024;
    const overlap = 256 * 1024;
    let endPos = fStat.size;

    while (endPos > 0) {
      const startPos = Math.max(0, endPos - windowSize);
      const readLen = endPos - startPos;
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fullFd, buf, 0, readLen, startPos);
      const slice = buf.subarray(0, bytesRead);

      let searchFrom = slice.length;
      while (searchFrom > 0) {
        const idx = slice.lastIndexOf(CHECKPOINT_TOKEN, searchFrom - 1);
        if (idx < 0) break;
        const lineStartNl = slice.lastIndexOf(0x0a, idx);
        if (lineStartNl < 0 && startPos > 0) {
          break;
        }
        const lineStart = lineStartNl < 0 ? 0 : lineStartNl + 1;
        const lineEndNl = slice.indexOf(0x0a, idx);
        const lineEnd = lineEndNl < 0 ? slice.length : lineEndNl;
        const lineStr = slice.subarray(lineStart, lineEnd).toString('utf-8').trim();
        searchFrom = lineStart;

        if (!lineStr) continue;
        try {
          const fObj = JSON.parse(lineStr);
          if (fObj.type !== 'CHECKPOINT') continue;
          if (targetStep >= 0 && typeof fObj.step_index === 'number' && fObj.step_index !== targetStep) {
            continue;
          }
          const overview = extractCheckpointOverview(fObj.content);
          if (overview) {
            entry.checkpointOverview = overview;
            return true;
          }
          return false;
        } catch {}
      }

      if (startPos === 0) break;
      endPos = Math.min(endPos - 1, startPos + overlap);
    }
  } catch {} finally {
    if (fullFd !== undefined) {
      try { fs.closeSync(fullFd); } catch {}
    }
  }
  return false;
}

function resolveFullHandoffPrompt(entry, transcriptPath) {
  if (!entry.needsFullHandoffRead) return false;
  const fullPath = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  if (!isFile(fullPath)) {
    entry.needsFullHandoffRead = false;
    entry.handoffTargetStepIndex = -1;
    return false;
  }

  let fullFd;
  let found = false;
  try {
    const fStat = fs.statSync(fullPath);
    const rSize = Math.min(fStat.size, 256 * 1024);
    fullFd = fs.openSync(fullPath, 'r');
    const fBuf = Buffer.allocUnsafe(rSize);
    const fRead = fs.readSync(fullFd, fBuf, 0, rSize, Math.max(0, fStat.size - rSize));
    const fLines = fBuf.subarray(0, fRead).toString('utf-8').split('\n');
    const targetStep = typeof entry.handoffTargetStepIndex === 'number' ? entry.handoffTargetStepIndex : -1;
    const minRequestStep = typeof entry.lastHandoffRequestStepIndex === 'number' ? entry.lastHandoffRequestStepIndex : -1;

    for (let i = fLines.length - 1; i >= 0; i--) {
      const fl = fLines[i].trim();
      if (!fl || !fl.includes('"type":"PLANNER_RESPONSE"')) continue;
      try {
        const fObj = JSON.parse(fl);
        if (fObj.type !== 'PLANNER_RESPONSE') continue;
        if (fObj.status === 'RUNNING') continue;
        if (targetStep >= 0 && (typeof fObj.step_index !== 'number' || fObj.step_index !== targetStep)) {
          continue;
        }
        if (minRequestStep >= 0 && typeof fObj.step_index === 'number' && fObj.step_index <= minRequestStep) {
          continue;
        }
        if (typeof fObj.content === 'string' && fObj.content.trim()) {
          const m = /<HANDOFF_PROMPT>\s*([\s\S]*?)\s*<\/HANDOFF_PROMPT>/i.exec(fObj.content);
          if (m && m[1].trim()) {
            entry.latestHandoffPrompt = m[1].trim();
            found = true;
          } else if (!Array.isArray(fObj.tool_calls) || fObj.tool_calls.length === 0) {
            entry.latestHandoffPrompt = fObj.content.trim();
            found = true;
          }
        }
        if (found || targetStep >= 0) break;
      } catch {}
    }
  } catch {} finally {
    if (fullFd !== undefined) {
      try { fs.closeSync(fullFd); } catch {}
    }
  }

  if (found) {
    const targetStep = typeof entry.handoffTargetStepIndex === 'number' ? entry.handoffTargetStepIndex : -1;
    entry.lastHandoffCompletedStepIndex = targetStep;
    entry.latestHandoffMs = Math.max(entry.handoffPendingMs || Date.now(), (entry.latestHandoffMs || 0) + 1, Date.now());
    entry.needsFullHandoffRead = false;
    entry.handoffTargetStepIndex = -1;
    return true;
  }

  if (Date.now() - (entry.handoffPendingMs || 0) > 15000) {
    entry.needsFullHandoffRead = false;
    entry.handoffTargetStepIndex = -1;
  }
  return false;
}

function copyPreservedEntryMeta(target, src) {
  if (!target || !src) return;
  target.modelEnum = src.modelEnum || '';
  target.modelLabel = src.modelLabel || '';
  target.modelResolvedMtimeMs = src.modelResolvedMtimeMs || 0;
  target.projectId = src.projectId || '';
  target.workspacePath = src.workspacePath || '';
  target.lsSummary = src.lsSummary || '';
  target.lastViewMs = src.lastViewMs || 0;
  target.lastUserInputMs = src.lastUserInputMs || 0;
  target.lastSeenMs = src.lastSeenMs || 0;
  target.manualUnreadAtMs = src.manualUnreadAtMs || 0;
  target.markedAsUnread = Boolean(src.markedAsUnread);
}

function updateTranscriptEntry(convId, transcriptPath, existingEntry, preStat) {
  let stat = preStat;
  if (!stat) {
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return null;
    }
  }

  if (
    existingEntry &&
    existingEntry.size === stat.size &&
    existingEntry.mtimeMs === stat.mtimeMs &&
    existingEntry.parsedBytes === stat.size
  ) {
    if (existingEntry.needsFullHandoffRead) {
      const resolved = resolveFullHandoffPrompt(existingEntry, transcriptPath);
      return { entry: existingEntry, changed: resolved };
    }
    return { entry: existingEntry, changed: false };
  }

  const lastLineOffset =
    existingEntry &&
    typeof existingEntry.lastLineOffset === 'number' &&
    existingEntry.lastLineOffset >= 0 &&
    existingEntry.lastLineOffset <= existingEntry.parsedBytes
      ? existingEntry.lastLineOffset
      : 0;

  let canIncremental =
    existingEntry &&
    existingEntry.parsedBytes > 0 &&
    typeof existingEntry.lastLineOffset === 'number' &&
    stat.size > lastLineOffset &&
    stat.size - lastLineOffset < 16 * 1024 * 1024;

  let entry = canIncremental ? existingEntry : createEmptyEntry(convId);
  if (!canIncremental && existingEntry) {
    copyPreservedEntryMeta(entry, existingEntry);
  }
  let startOffset = canIncremental ? lastLineOffset : 0;
  let bytesToRead = stat.size - startOffset;

  if (bytesToRead <= 0) {
    if (existingEntry) {
      existingEntry.mtimeMs = stat.mtimeMs;
      existingEntry.size = stat.size;
      return { entry: existingEntry, changed: false };
    }
    entry.mtimeMs = stat.mtimeMs;
    entry.size = stat.size;
    return { entry, changed: false };
  }

  let fd;
  let buf;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    if (canIncremental && startOffset > 0) {
      const probeLen = bytesToRead + 1;
      const probeBuf = Buffer.allocUnsafe(probeLen);
      const probeRead = fs.readSync(fd, probeBuf, 0, probeLen, startOffset - 1);
      const slice = probeBuf.subarray(0, probeRead);
      if (slice.length < 2 || slice[0] !== 0x0a || slice[1] !== 0x7b) {
        canIncremental = false;
        entry = createEmptyEntry(convId);
        copyPreservedEntryMeta(entry, existingEntry);
        startOffset = 0;
        bytesToRead = stat.size;
        buf = Buffer.allocUnsafe(bytesToRead);
        const fullRead = fs.readSync(fd, buf, 0, bytesToRead, 0);
        buf = buf.subarray(0, fullRead);
      } else {
        buf = slice.subarray(1);
      }
    } else {
      buf = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, startOffset);
      buf = buf.subarray(0, bytesRead);
    }
  } catch {
    return existingEntry ? { entry: existingEntry, changed: false } : null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const lastNewlineIdx = buf.lastIndexOf(0x0a);
  if (lastNewlineIdx < 0) {
    const trimmedBuf = buf.toString('utf-8').trim();
    if (!trimmedBuf) {
      if (existingEntry) {
        existingEntry.mtimeMs = stat.mtimeMs;
        existingEntry.size = stat.size;
        return { entry: existingEntry, changed: false };
      }
      entry.mtimeMs = stat.mtimeMs;
      entry.size = stat.size;
      return { entry, changed: false };
    }
    try {
      JSON.parse(trimmedBuf);
    } catch {
      return existingEntry ? { entry: existingEntry, changed: false } : null;
    }
  }

  const completeBuf = lastNewlineIdx >= 0 ? buf.subarray(0, lastNewlineIdx + 1) : buf;
  const text = completeBuf.toString('utf-8');
  const lines = text.split('\n');

  const prevHandoffMs = entry.latestHandoffMs || 0;
  let isFirstLine = startOffset === 0;
  let corpusDirty = !canIncremental;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (processTranscriptLine(entry, line, isFirstLine)) {
      corpusDirty = true;
    }
    isFirstLine = false;
  }

  if (entry.needsFullCheckpointRead) {
    if (resolveFullCheckpointOverview(entry, transcriptPath)) {
      corpusDirty = true;
    }
  }

  if (entry.needsFullHandoffRead) {
    resolveFullHandoffPrompt(entry, transcriptPath);
  }

  if (canIncremental && (entry.latestHandoffMs || 0) > prevHandoffMs) {
    entry.latestHandoffMs = Math.max(entry.latestHandoffMs || 0, Math.floor(stat.mtimeMs || 0), Date.now());
  }

  let endPos = completeBuf.length;
  while (endPos > 0 && (completeBuf[endPos - 1] === 0x0a || completeBuf[endPos - 1] === 0x0d)) {
    endPos--;
  }
  if (endPos > 0) {
    const prevNlIdx = completeBuf.lastIndexOf(0x0a, endPos - 1);
    entry.lastLineOffset = startOffset + (prevNlIdx >= 0 ? prevNlIdx + 1 : 0);
  }
  entry.parsedBytes = lastNewlineIdx >= 0 ? startOffset + lastNewlineIdx + 1 : stat.size;
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  if (
    entry.lastStepType === 'USER_INPUT' &&
    entry.lastUserInputMs > 0 &&
    stat.mtimeMs > entry.lastUserInputMs &&
    stat.mtimeMs - entry.lastUserInputMs < 1000
  ) {
    entry.lastUserInputMs = Math.floor(stat.mtimeMs);
  }
  // A completed reply's created_at can be earlier than the moment it finished writing, which may be
  // after the user already switched away and stamped lastViewMs. Without the mtime the reply looks
  // older than the view and the blue dot never lights. Do not reintroduce a "mtime within 1 s of
  // created_at" guard here (regression from 70c1a40). lastStepIsCompletedReply keeps tool-call and
  // thinking steps from bumping it.
  if (
    entry.lastStepType === 'PLANNER_RESPONSE' &&
    entry.lastStepIsCompletedReply &&
    stat.mtimeMs > (entry.lastModelResponseMs || 0)
  ) {
    const mtimeFloor = Math.floor(stat.mtimeMs);
    entry.lastModelResponseMs = mtimeFloor;
    if (mtimeFloor > (entry.lastActiveMs || 0)) {
      entry.lastActiveMs = mtimeFloor;
      entry.lastActiveIso = new Date(mtimeFloor).toISOString();
    }
  }
  if (!entry.lastActiveMs) {
    entry.lastActiveMs = stat.mtimeMs;
    entry.lastActiveIso = new Date(stat.mtimeMs).toISOString();
  }
  if (corpusDirty || !entry.searchCorpusLower) {
    rebuildSearchCorpus(entry);
  }
  return { entry, changed: true };
}

function parseGitReflogTail(repoPath, maxEntries = 200) {
  const logFile = path.join(repoPath, '.git', 'logs', 'HEAD');
  if (!isFile(logFile)) return [];

  let fd;
  try {
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 64 * 1024);
    const startPos = Math.max(0, stat.size - readSize);
    fd = fs.openSync(logFile, 'r');
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, startPos);
    const raw = buf.subarray(0, bytesRead).toString('utf-8');
    const lines = raw.trim().split('\n');
    const commits = [];
    const seen = new Set();

    for (let i = lines.length - 1; i >= 0 && commits.length < maxEntries; i--) {
      const line = lines[i];
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const meta = line.slice(0, tabIdx).trim();
      const action = line.slice(tabIdx + 1).trim();
      if (!REFLOG_ACTION_RE.test(action)) {
        continue;
      }
      const metaMatch = /^([0-9a-f]{40})\s+([0-9a-f]{40})\s+.*\s+(\d{9,12})\s+([+-]\d{4})$/i.exec(meta);
      if (!metaMatch) continue;
      const hash = metaMatch[2].toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const tsSec = parseInt(metaMatch[3], 10);
      const tsMs = tsSec * 1000;
      const subject = action.replace(/^commit(?:\s*\([^)]+\))?:\s*/i, '').trim();
      commits.push({
        hash,
        short: hash.slice(0, 7),
        iso: new Date(tsMs).toISOString(),
        tsMs,
        subject
      });
    }
    return commits;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

class GitRepoCache {
  constructor() {
    this.repos = new Map();
    this.revision = 1;
  }

  getHeadMtime(repoPath) {
    let m1 = 0;
    let m2 = 0;
    try {
      m1 = fs.statSync(path.join(repoPath, '.git', 'HEAD'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    } catch {}
    try {
      m2 = fs.statSync(path.join(repoPath, '.git', 'logs', 'HEAD'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    } catch {}
    return `${m1}:${m2}`;
  }

  invalidateMtimeChecks() {
    for (const record of this.repos.values()) {
      record.checkedAtMs = 0;
    }
  }

  checkKnownRepos(force = false) {
    for (const repoPath of this.repos.keys()) {
      this.getRepoRecord(repoPath, force);
    }
  }

  getRepoRecord(repoPath, force = false) {
    if (!repoPath) return null;
    const now = Date.now();
    const existing = this.repos.get(repoPath);
    if (!force && existing && now - existing.checkedAtMs < 1500) {
      return existing;
    }

    const signature = this.getHeadMtime(repoPath);
    if (signature === '0:0') {
      const hasGit = existing && existing.signature === '0:0'
        ? existing.hasGit
        : isDirectory(path.join(repoPath, '.git'));
      if (!existing || existing.signature !== '0:0' || existing.hasGit !== hasGit) {
        this.revision += 1;
      }
      const emptyRecord = {
        signature: '0:0',
        hasGit,
        commits: [],
        refreshing: false,
        checkedAtMs: now
      };
      this.repos.set(repoPath, emptyRecord);
      return emptyRecord;
    }

    if (existing && existing.signature === signature) {
      existing.checkedAtMs = now;
      if (force && !existing.refreshing) {
        this.refreshViaGitAsync(repoPath, signature);
      }
      return existing;
    }

    const reflogCommits = parseGitReflogTail(repoPath, 200);
    const record = {
      signature,
      hasGit: true,
      commits: reflogCommits.length > 0 || !existing ? reflogCommits : existing.commits,
      refreshing: existing ? existing.refreshing : false,
      checkedAtMs: now
    };
    this.repos.set(repoPath, record);
    this.revision += 1;

    this.refreshViaGitAsync(repoPath, signature);
    return record;
  }

  getRepoCommits(repoPath, force = false) {
    const rec = this.getRepoRecord(repoPath, force);
    return rec ? rec.commits : [];
  }

  refreshViaGitAsync(repoPath, signature) {
    const record = this.repos.get(repoPath);
    if (!record || record.refreshing) return;
    record.refreshing = true;
    const nativeRepo = process.platform === 'win32' ? repoPath.replace(/\//g, '\\') : repoPath;

    execFile(
      'git',
      ['-C', nativeRepo, '--no-pager', 'log', '-n', '200', '--format=%H%x1f%h%x1f%cI%x1f%ct%x1f%s', 'HEAD'],
      { encoding: 'utf-8', timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        record.refreshing = false;
        if (err || !stdout) return;
        const commits = [];
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          const parts = line.split('\x1f');
          if (parts.length < 5) continue;
          const [hash, short, iso, ctStr, subject] = parts;
          const tsMs = parseInt(ctStr, 10) * 1000;
          if (!Number.isFinite(tsMs)) continue;
          commits.push({
            hash: hash.trim().toLowerCase(),
            short: short.trim().toLowerCase(),
            iso: iso.trim(),
            tsMs,
            subject: subject.trim()
          });
        }
        if (commits.length > 0) {
          this.repos.set(repoPath, {
            signature,
            hasGit: true,
            commits,
            refreshing: false,
            checkedAtMs: Date.now()
          });
          this.revision += 1;
        }
      }
    );
  }

  computeDriftForConversation(entry) {
    if (!entry.workspacePath || !entry.lastActiveMs) {
      return {
        hasGit: false,
        commitsBehind: 0,
        missedCommits: []
      };
    }
    const record = this.getRepoRecord(entry.workspacePath);
    if (!record || record.commits.length === 0) {
      return {
        hasGit: Boolean(record && record.hasGit),
        commitsBehind: 0,
        missedCommits: []
      };
    }

    const commits = record.commits;
    const graceCutoffMs = entry.lastActiveMs + 1000;
    if (commits[0].tsMs <= graceCutoffMs) {
      return {
        hasGit: true,
        commitsBehind: 0,
        missedCommits: []
      };
    }

    const mentioned = new Set(entry.mentionedCommits || []);
    const missed = [];

    for (const c of commits) {
      if (c.tsMs <= graceCutoffMs) break;
      if (mentioned.has(c.hash.slice(0, 7))) {
        continue;
      }
      missed.push(c);
    }

    return {
      hasGit: true,
      commitsBehind: missed.length,
      missedCommits: missed.slice(0, 8)
    };
  }
}

const LSRPC_CONTRACT_SPECS = [
  {
    method: 'GetCascadeModelConfigData',
    critical: true,
    caller: 'server.cjs:getModelsCatalog, parseCascadeModelConfigs',
    purpose: 'Fetch available model catalog and default model'
  },
  {
    method: 'GetCascadeTrajectoryGeneratorMetadata',
    critical: true,
    caller: 'server.cjs:resolveConversationModelAsync',
    purpose: 'Resolve active model used by a conversation'
  },
  {
    method: 'LoadTrajectory',
    critical: false,
    caller: 'server.cjs:resolveConversationModelAsync',
    purpose: 'Warm trajectory in Language Server before reading generator metadata'
  },
  {
    method: 'StartCascade',
    critical: false,
    caller: 'server.cjs:handleRequest (POST /_sidecar/new-conversation)',
    purpose: 'Create new conversation via Language Server RPC (falls back to agentapi CLI)'
  },
  {
    method: 'SendUserCascadeMessage',
    critical: false,
    caller: 'server.cjs:handleRequest (POST /_sidecar/send-message, POST /_sidecar/new-conversation)',
    purpose: 'Send user or smart handoff prompt to an existing or newly created cascade (falls back to agentapi CLI)'
  },
  {
    method: 'UpdateConversationAnnotations',
    critical: false,
    caller: 'server.cjs:setConversationArchived, setConversationUnread, clearConversationUnreadAnnotation, setConversationCustomTitle',
    purpose: 'Archive/unarchive, rename, and mark conversation unread/read via RPC (falls back to .pbtxt file edit)'
  },
  {
    method: 'GetAllCascadeTrajectories',
    critical: false,
    caller: 'server.cjs:syncTrajectoriesFromLanguageServer',
    purpose: 'Fetch official trajectory projectId, workspaceUris, and default summary from Language Server'
  },
  {
    method: 'DeleteCascadeTrajectory',
    critical: false,
    caller: 'server.cjs:deleteConversation',
    purpose: 'Delete trajectory via RPC (falls back to on-disk brain/conversations/annotations removal)'
  },
  {
    method: 'CancelCascadeInvocation',
    critical: false,
    caller: 'server.cjs:handleRequest (POST /api/cancel-invocation)',
    purpose: 'Abort active cascade invocation when cancelling smart handoff generation'
  },
  {
    method: 'RetrieveUserQuotaSummary',
    critical: false,
    caller: 'server.cjs:refreshQuotaSummary, parseUserQuotaSummary',
    purpose: 'Fetch 5-hour / weekly model quota buckets for the header usage ring (falls back to clientModelConfigs[].quotaInfo)'
  }
];

const binarySymbolCache = new Map();

function resolveLanguageServerBinary(appDataDir) {
  const geminiRoot = path.join(os.homedir(), '.gemini');
  const candidateDirs = [
    appDataDir || resolveAppDataDir(),
    ...APP_CANDIDATES.map((app) => path.join(geminiRoot, app))
  ].filter(Boolean);

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const langServer = path.join(localApp, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (isFile(langServer)) return langServer;
    for (const d of candidateDirs) {
      const bat = path.join(d, 'bin', 'agentapi.bat');
      if (isFile(bat)) {
        try {
          const batContent = fs.readFileSync(bat, 'utf-8');
          const exeMatch = /"([^"]+\.exe)"/i.exec(batContent);
          if (exeMatch && isFile(exeMatch[1])) return exeMatch[1];
        } catch {}
      }
    }
    return '';
  }

  for (const d of candidateDirs) {
    const nixBin = path.join(d, 'bin', 'agentapi');
    if (isFile(nixBin)) {
      try {
        const scriptContent = fs.readFileSync(nixBin, 'utf-8');
        const binMatch = /"([^"\n]+language_server[^"\n]*)"/.exec(scriptContent);
        if (binMatch && isFile(binMatch[1])) return binMatch[1];
      } catch {}
    }
  }

  const linuxCandidates = [
    '/opt/Antigravity/resources/bin/language_server_linux_x64',
    '/opt/Antigravity/resources/bin/language_server',
    '/opt/antigravity/resources/bin/language_server_linux_x64',
    '/opt/antigravity/resources/bin/language_server',
    '/usr/share/antigravity/resources/bin/language_server',
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server')
  ];
  for (const binPath of linuxCandidates) {
    if (isFile(binPath)) return binPath;
  }
  return '';
}

function scanBinarySymbols(binaryPath, symbols) {
  const result = {
    found: new Set(),
    missing: [],
    mtimeMs: 0,
    size: 0,
    error: ''
  };
  if (!binaryPath || !isFile(binaryPath)) {
    result.missing = [...symbols];
    result.error = 'Binary file not found';
    return result;
  }
  let stat;
  try {
    stat = fs.statSync(binaryPath);
  } catch (err) {
    result.missing = [...symbols];
    result.error = err.message;
    return result;
  }
  result.mtimeMs = Math.floor(stat.mtimeMs || 0);
  result.size = stat.size || 0;

  const cacheKey = `${binaryPath}|${result.mtimeMs}|${result.size}|${symbols.join(',')}`;
  if (binarySymbolCache.has(cacheKey)) {
    const cachedFound = binarySymbolCache.get(cacheKey);
    result.found = new Set(cachedFound);
    result.missing = symbols.filter((s) => !result.found.has(s));
    return result;
  }

  const pending = new Map();
  for (const sym of symbols) {
    if (sym) pending.set(sym, Buffer.from(sym, 'utf-8'));
  }

  let fd;
  try {
    fd = fs.openSync(binaryPath, 'r');
    const chunkSize = 4 * 1024 * 1024;
    const overlap = 256;
    const buf = Buffer.allocUnsafe(chunkSize + overlap);
    let pos = 0;
    let carryLen = 0;

    while (pos < stat.size && pending.size > 0) {
      const toRead = Math.min(chunkSize, stat.size - pos);
      const bytesRead = fs.readSync(fd, buf, carryLen, toRead, pos);
      if (bytesRead <= 0) break;
      const windowSlice = buf.subarray(0, carryLen + bytesRead);
      for (const [sym, needle] of pending.entries()) {
        if (windowSlice.includes(needle)) {
          result.found.add(sym);
          pending.delete(sym);
        }
      }
      pos += bytesRead;
      if (pos < stat.size && pending.size > 0) {
        carryLen = Math.min(overlap, windowSlice.length);
        windowSlice.subarray(windowSlice.length - carryLen).copy(buf, 0);
      }
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  result.missing = symbols.filter((s) => !result.found.has(s));
  if (!result.error) {
    if (binarySymbolCache.size > 8) binarySymbolCache.clear();
    binarySymbolCache.set(cacheKey, [...result.found]);
  }
  return result;
}

function readFileTailLines(filePath, maxBytes = 512 * 1024, maxLines = 80) {
  let fd;
  try {
    const st = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size <= 0) return [];
    const readSize = Math.min(st.size, maxBytes);
    const startOffset = Math.max(0, st.size - readSize);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, startOffset);
    let text = buf.subarray(0, bytesRead).toString('utf-8');
    if (startOffset > 0) {
      const firstNl = text.indexOf('\n');
      if (firstNl >= 0) {
        text = text.slice(firstNl + 1);
      }
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function resolveAgentApiCommand(appDataDir) {
  const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
  if (envExe && isFile(envExe)) {
    const isDirect = path.basename(envExe).toLowerCase().startsWith('agentapi');
    return { file: envExe, prefix: isDirect ? [] : ['agentapi'], shell: false };
  }

  const lsBin = resolveLanguageServerBinary(appDataDir);
  if (lsBin) {
    return { file: lsBin, prefix: ['agentapi'], shell: false };
  }

  const geminiRoot = path.join(os.homedir(), '.gemini');
  const candidateDirs = [
    appDataDir || resolveAppDataDir(),
    ...APP_CANDIDATES.map((app) => path.join(geminiRoot, app))
  ].filter(Boolean);
  const wrapperName = process.platform === 'win32' ? 'agentapi.bat' : 'agentapi';
  const useShell = process.platform === 'win32';
  for (const d of candidateDirs) {
    const wrapper = path.join(d, 'bin', wrapperName);
    if (isFile(wrapper)) {
      return { file: wrapper, prefix: [], shell: useShell };
    }
  }
  return { file: 'agentapi', prefix: [], shell: useShell };
}

function execAgentApi(args, projectId, appDataDir, workspacePath = '', timeoutMs = 12000, clearProjectEnv = false) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (clearProjectEnv) {
      delete env.ANTIGRAVITY_PROJECT_ID;
    } else if (projectId) {
      env.ANTIGRAVITY_PROJECT_ID = projectId;
    }
    const cwd = workspacePath && isDirectory(workspacePath) ? workspacePath : os.homedir();
    const { file, prefix, shell } = resolveAgentApiCommand(appDataDir);
    execFile(
      file,
      [...prefix, ...args],
      { encoding: 'utf-8', env, cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell },
      (err, stdout, stderr) => {
        if (err) {
          const errMsg = stderr ? `${err.message}: ${stderr}` : err.message;
          resolve({ error: errMsg, stderr: stderr ? String(stderr) : undefined });
          return;
        }
        const trimmed = stdout ? String(stdout).trim() : '';
        if (!trimmed) {
          resolve({ success: true });
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          resolve(parsed);
        } catch {
          resolve({ success: true, raw: trimmed });
        }
      }
    );
  });
}

function callLanguageServerRpc(method, payload = {}, timeoutMs = 4000) {
  const rawAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!rawAddr || !csrf) {
    return Promise.resolve({ error: 'Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN' });
  }
  const baseUrl = /^https?:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`;
  let urlObj;
  try {
    urlObj = new URL(`/exa.language_server_pb.LanguageServerService/${method}`, baseUrl);
  } catch (err) {
    return Promise.resolve({ error: err.message });
  }
  const bodyBuf = Buffer.from(JSON.stringify(payload || {}), 'utf-8');
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': bodyBuf.length
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8').trim();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ error: `HTTP ${res.statusCode}: ${raw.slice(0, 300)}`, statusCode: res.statusCode });
            return;
          }
          if (!raw) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ error: 'Invalid JSON response from Language Server' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: `Language Server RPC ${method} timed out` });
    });
    req.on('error', (err) => {
      resolve({ error: err.message });
    });
    req.write(bodyBuf);
    req.end();
  });
}

function parseModelFamilyAndTier(label) {
  const clean = (typeof label === 'string' ? label : '').trim();
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(clean);
  if (m && m[1].trim()) {
    return { family: m[1].trim(), tier: m[2].trim() };
  }
  return { family: clean, tier: '' };
}

function getTierSortWeight(tier) {
  const t = (tier || '').trim().toLowerCase();
  if (!t) return 0;
  if (t === 'max' || t === 'extra high' || t === 'ultra' || t === 'elite' || t === 'pro') return 10;
  if (t === 'high') return 20;
  if (t === 'thinking') return 25;
  if (t === 'medium') return 30;
  if (t === 'low thinking') return 40;
  if (t === 'low') return 50;
  if (t === 'extra low' || t === 'minimal' || t === 'lite') return 60;
  return 35;
}

function parseCascadeModelConfigs(data) {
  if (!data || typeof data !== 'object' || data.error) {
    return { models: [], defaultModelEnum: '', modelQuotas: [] };
  }
  const defaultModelEnum =
    (data.defaultOverrideModelConfig &&
      data.defaultOverrideModelConfig.modelOrAlias &&
      (data.defaultOverrideModelConfig.modelOrAlias.model ||
        data.defaultOverrideModelConfig.modelOrAlias.alias)) ||
    '';

  const recommendedLabelOrder = new Map();
  const recommendedFamilyOrder = new Map();
  const sorts = Array.isArray(data.clientModelSorts) ? data.clientModelSorts : [];
  for (const s of sorts) {
    const groups = Array.isArray(s && s.groups) ? s.groups : [];
    for (const g of groups) {
      const labels = Array.isArray(g && g.modelLabels) ? g.modelLabels : [];
      for (const lbl of labels) {
        if (typeof lbl === 'string' && lbl.trim()) {
          const cleanLbl = lbl.trim();
          if (!recommendedLabelOrder.has(cleanLbl)) {
            recommendedLabelOrder.set(cleanLbl, recommendedLabelOrder.size);
          }
          const { family } = parseModelFamilyAndTier(cleanLbl);
          if (family && !recommendedFamilyOrder.has(family)) {
            recommendedFamilyOrder.set(family, recommendedFamilyOrder.size);
          }
        }
      }
    }
  }

  const rawConfigs = Array.isArray(data.clientModelConfigs) ? data.clientModelConfigs : [];
  const seenEnums = new Set();
  const models = [];
  const modelQuotas = [];

  for (const cfg of rawConfigs) {
    if (!cfg || cfg.disabled) continue;
    const label = typeof cfg.label === 'string' ? cfg.label.trim() : '';
    const isAlias = Boolean(cfg.modelOrAlias && !cfg.modelOrAlias.model && cfg.modelOrAlias.alias);
    const modelEnum =
      (cfg.modelOrAlias && (cfg.modelOrAlias.model || cfg.modelOrAlias.alias)) || '';
    if (!label || !modelEnum || modelEnum === 'MODEL_UNSPECIFIED') continue;
    if (seenEnums.has(modelEnum)) continue;
    seenEnums.add(modelEnum);

    const qi = cfg.quotaInfo;
    if (qi && typeof qi === 'object' && (qi.remainingFraction !== undefined || qi.resetTime)) {
      modelQuotas.push({
        label,
        modelId: typeof cfg.modelId === 'string' ? cfg.modelId : '',
        provider: typeof cfg.provider === 'string' ? cfg.provider : '',
        // proto3 JSON omits a zero remainingFraction on this non-oneof field, so a quotaInfo
        // that only carries resetTime means the window is exhausted.
        remainingFraction: qi.remainingFraction !== undefined ? Number(qi.remainingFraction) : 0,
        resetTime: typeof qi.resetTime === 'string' ? qi.resetTime : ''
      });
    }

    const { family, tier } = parseModelFamilyAndTier(label);
    const recommended =
      recommendedFamilyOrder.has(family) ||
      recommendedLabelOrder.has(label) ||
      Boolean(cfg.isRecommended);

    models.push({
      label,
      modelEnum,
      isAlias,
      modelId: typeof cfg.modelId === 'string' ? cfg.modelId.trim() : '',
      family,
      tier,
      recommended,
      tagTitle: typeof cfg.tagTitle === 'string' ? cfg.tagTitle.trim() : ''
    });
  }

  models.sort((a, b) => {
    const aFamRec = recommendedFamilyOrder.has(a.family) ? recommendedFamilyOrder.get(a.family) : 9999;
    const bFamRec = recommendedFamilyOrder.has(b.family) ? recommendedFamilyOrder.get(b.family) : 9999;
    if (aFamRec !== bFamRec) return aFamRec - bFamRec;

    if (a.family !== b.family) {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.family.localeCompare(b.family, undefined, { numeric: true, sensitivity: 'base' });
    }

    const aLblRec = recommendedLabelOrder.has(a.label) ? recommendedLabelOrder.get(a.label) : 9999;
    const bLblRec = recommendedLabelOrder.has(b.label) ? recommendedLabelOrder.get(b.label) : 9999;
    if (aLblRec !== bLblRec && aLblRec !== 9999 && bLblRec !== 9999) {
      return aLblRec - bLblRec;
    }

    const aWeight = getTierSortWeight(a.tier);
    const bWeight = getTierSortWeight(b.tier);
    if (aWeight !== bWeight) {
      if (aWeight === 35 && aLblRec !== 9999) return -1;
      if (bWeight === 35 && bLblRec !== 9999) return 1;
      return aWeight - bWeight;
    }
    if (aLblRec !== bLblRec) return aLblRec - bLblRec;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
  });

  return { models, defaultModelEnum, modelQuotas };
}

const QUOTA_FAMILY_RULES = [
  { key: 'gemini', label: 'Google Gemini', re: /gemini|google/i, excludeRe: /argon/i },
  { key: 'claude', label: 'Anthropic Claude', re: /claude|anthropic|opus|sonnet|haiku/i },
  { key: 'argon', label: 'Gemini 4 Argon', re: /argon/i },
  { key: 'openai', label: 'OpenAI', re: /openai|\bgpt|codex/i }
];

const QUOTA_WINDOW_ORDER = { '5h': 0, daily: 1, weekly: 2, monthly: 3, other: 4 };
const QUOTA_WINDOW_LABELS = { '5h': '5-hour', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const QUOTA_DURATION_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

function classifyQuotaFamilies(...texts) {
  const joined = texts.filter((t) => typeof t === 'string' && t).join(' ');
  if (!joined) return [];
  return QUOTA_FAMILY_RULES.filter((r) => r.re.test(joined) && (!r.excludeRe || !r.excludeRe.test(joined)));
}

function classifyQuotaFamily(...texts) {
  return classifyQuotaFamilies(...texts)[0] || null;
}

function parseQuotaWindowSeconds(windowText) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i.exec(windowText || '');
  return m ? Number(m[1]) * QUOTA_DURATION_UNIT_SECONDS[m[2].toLowerCase()] : 0;
}

function classifyQuotaWindow(windowText, ...hints) {
  const seconds = parseQuotaWindowSeconds(windowText);
  if (seconds > 0) {
    if (Math.abs(seconds - 18000) < 60) return { kind: '5h', label: QUOTA_WINDOW_LABELS['5h'] };
    if (Math.abs(seconds - 86400) < 60) return { kind: 'daily', label: QUOTA_WINDOW_LABELS.daily };
    if (Math.abs(seconds - 604800) < 60) return { kind: 'weekly', label: QUOTA_WINDOW_LABELS.weekly };
    const hours = seconds / 3600;
    const label = hours >= 48 && hours % 24 === 0 ? `${hours / 24}-day` : `${Number(hours.toFixed(1))}-hour`;
    return { kind: 'other', label };
  }
  const text = [windowText, ...hints].filter((t) => typeof t === 'string' && t).join(' ').toLowerCase();
  if (/week|7\s*-?\s*d(ay)?\b|168\s*h/.test(text)) return { kind: 'weekly', label: QUOTA_WINDOW_LABELS.weekly };
  if (/(^|[^\d.])5\s*-?\s*h(our|r)?s?\b|five[\s_-]*hour/.test(text)) return { kind: '5h', label: QUOTA_WINDOW_LABELS['5h'] };
  if (/\bdaily\b|\bday\b|24\s*-?\s*h/.test(text)) return { kind: 'daily', label: QUOTA_WINDOW_LABELS.daily };
  if (/month|30\s*-?\s*d/.test(text)) return { kind: 'monthly', label: QUOTA_WINDOW_LABELS.monthly };
  return { kind: 'other', label: '' };
}

function normalizeQuotaBucket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fraction = Number(raw.remainingFraction);
  const hasFraction = raw.remainingFraction !== undefined && raw.remainingFraction !== null && Number.isFinite(fraction);
  const amount = Number(raw.remainingAmount);
  const hasAmount = raw.remainingAmount !== undefined && raw.remainingAmount !== null && Number.isFinite(amount);
  if (!hasFraction && !hasAmount && !raw.disabled) return null;

  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  const bucketId = typeof raw.bucketId === 'string' ? raw.bucketId.trim() : '';
  const windowText = typeof raw.window === 'string' ? raw.window.trim() : '';
  const win = classifyQuotaWindow(windowText, bucketId, displayName);
  const remainingPct = hasFraction ? Math.min(100, Math.max(0, fraction * 100)) : null;
  const resetMs = typeof raw.resetTime === 'string' ? Date.parse(raw.resetTime) || 0 : 0;
  return {
    id: bucketId || displayName || windowText,
    label: displayName,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    windowKind: win.kind,
    windowLabel: win.label || displayName || windowText || 'Quota',
    usedPct: remainingPct === null ? null : Number((100 - remainingPct).toFixed(1)),
    remainingPct: remainingPct === null ? null : Number(remainingPct.toFixed(1)),
    remainingAmount: hasAmount ? amount : null,
    resetMs,
    disabled: Boolean(raw.disabled)
  };
}

function finalizeQuotaGroups(groupMap) {
  const groups = [];
  for (const g of groupMap.values()) {
    if (g.buckets.length === 0) continue;
    g.buckets.sort((a, b) =>
      (QUOTA_WINDOW_ORDER[a.windowKind] ?? 9) - (QUOTA_WINDOW_ORDER[b.windowKind] ?? 9) ||
      (a.resetMs || 0) - (b.resetMs || 0)
    );
    const usedValues = g.buckets.filter((b) => !b.disabled && b.usedPct !== null).map((b) => b.usedPct);
    g.maxUsedPct = usedValues.length > 0 ? Math.max(...usedValues) : null;
    groups.push(g);
  }
  const familyRank = (key) => {
    const idx = QUOTA_FAMILY_RULES.findIndex((r) => r.key === key);
    return idx === -1 ? QUOTA_FAMILY_RULES.length : idx;
  };
  groups.sort((a, b) => {
    const aOrder = typeof a.orderIndex === 'number' ? a.orderIndex : 9999;
    const bOrder = typeof b.orderIndex === 'number' ? b.orderIndex : 9999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return familyRank(a.family) - familyRank(b.family) || a.label.localeCompare(b.label);
  });
  return groups;
}

function addQuotaBucketToGroup(groupMap, familyRules, fallbackLabel, bucket, explicitKey = '') {
  const rules = Array.isArray(familyRules) ? familyRules : (familyRules ? [familyRules] : []);
  const primaryRule = rules[0] || null;
  const families = rules.map((r) => r.key);
  const key = explicitKey || (primaryRule ? primaryRule.key : (fallbackLabel || 'general').toLowerCase());
  let group = groupMap.get(key);
  if (!group) {
    group = {
      key,
      family: primaryRule ? primaryRule.key : '',
      families,
      label: fallbackLabel || (primaryRule ? primaryRule.label : 'General'),
      description: '',
      buckets: [],
      maxUsedPct: null
    };
    groupMap.set(key, group);
  } else {
    for (const f of families) {
      if (!group.families.includes(f)) group.families.push(f);
    }
  }
  group.buckets.push(bucket);
  return group;
}

function parseUserQuotaSummary(res) {
  if (!res || typeof res !== 'object' || res.error) return null;
  const root = res.response && typeof res.response === 'object' ? res.response : res;
  const groupMap = new Map();

  const rawGroups = Array.isArray(root.groups) ? root.groups : [];
  for (let gi = 0; gi < rawGroups.length; gi++) {
    const g = rawGroups[gi];
    if (!g || typeof g !== 'object') continue;
    const groupLabel = typeof g.displayName === 'string' ? g.displayName.trim() : '';
    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
    const bucketHints = rawBuckets.flatMap((b) => [b && b.displayName, b && b.bucketId]);
    let familyRules = classifyQuotaFamilies(groupLabel);
    if (familyRules.length === 0) familyRules = classifyQuotaFamilies(g.description);
    if (familyRules.length === 0) familyRules = classifyQuotaFamilies(...bucketHints);
    const primaryKey = familyRules[0] ? familyRules[0].key : '';
    const baseKey = primaryKey || (groupLabel ? groupLabel.toLowerCase().replace(/[^a-z0-9_]+/g, '_') : `group_${gi}`);
    const existingGroup = groupMap.get(baseKey);
    const groupKey = (existingGroup && existingGroup.label && groupLabel && existingGroup.label !== groupLabel)
      ? `${baseKey}_${gi}`
      : baseKey;

    for (const rb of rawBuckets) {
      const bucket = normalizeQuotaBucket(rb);
      if (!bucket) continue;
      const group = addQuotaBucketToGroup(groupMap, familyRules, groupLabel, bucket, groupKey);
      if (typeof group.orderIndex !== 'number') {
        group.orderIndex = gi;
      }
      if (!group.description && typeof g.description === 'string') {
        group.description = g.description.trim();
      }
    }
  }

  const rawTopBuckets = Array.isArray(root.buckets) ? root.buckets : [];
  for (const rb of rawTopBuckets) {
    const bucket = normalizeQuotaBucket(rb);
    if (!bucket) continue;
    const familyRules = classifyQuotaFamilies(rb.displayName, rb.bucketId, rb.description);
    const primaryRule = familyRules[0] || null;
    const existing = primaryRule ? groupMap.get(primaryRule.key) : null;
    addQuotaBucketToGroup(groupMap, familyRules, existing ? existing.label : '', bucket);
  }

  return {
    source: 'quota_summary',
    description: typeof root.description === 'string' ? root.description.trim() : '',
    groups: finalizeQuotaGroups(groupMap)
  };
}

function buildQuotaFromModelConfigs(modelQuotas) {
  const groupMap = new Map();
  for (const mq of Array.isArray(modelQuotas) ? modelQuotas : []) {
    const familyRule = classifyQuotaFamily(mq.label, mq.modelId, mq.provider);
    const key = familyRule ? familyRule.key : 'general';
    const existing = groupMap.get(key);
    const prevBucket = existing && existing.buckets[0];
    if (prevBucket && prevBucket.remainingPct !== null && prevBucket.remainingPct <= mq.remainingFraction * 100) {
      continue;
    }
    const bucket = normalizeQuotaBucket({
      displayName: mq.label,
      remainingFraction: mq.remainingFraction,
      resetTime: mq.resetTime
    });
    if (!bucket) continue;
    bucket.windowKind = 'other';
    bucket.windowLabel = 'Current window';
    if (existing) {
      existing.buckets = [bucket];
    } else {
      addQuotaBucketToGroup(groupMap, familyRule, '', bucket);
    }
  }
  return { source: 'model_config', description: '', groups: finalizeQuotaGroups(groupMap) };
}

function summarizeQuotaForDiagnostics(quota) {
  if (!quota || !Array.isArray(quota.groups) || quota.groups.length === 0) return 'no quota buckets';
  return quota.groups
    .map((g) => `${g.label} [${g.buckets.map((b) => `${b.windowLabel} ${b.usedPct === null ? '?' : b.usedPct + '%'} used`).join(', ')}]`)
    .join('; ');
}

function rewriteUiHtmlLinks(html, token, conversationId) {
  const bootScript = `<script>window.__SIDECAR_BOOT__=${JSON.stringify({
    token: token || '',
    conversationId: conversationId || ''
  })};</script>`;
  let out = html.includes('</head>')
    ? html.replace('</head>', `${bootScript}</head>`)
    : bootScript + html;

  if (!token && !conversationId) return out;
  const queryParts = [];
  if (token) queryParts.push(`token=${encodeURIComponent(token)}`);
  if (conversationId) queryParts.push(`conversationId=${encodeURIComponent(conversationId)}`);
  const qs = queryParts.join('&');

  return out.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, urlPath) => {
    if (urlPath.startsWith('//')) return match;
    const [base, ...hashParts] = urlPath.split('#');
    const hash = hashParts.length > 0 ? `#${hashParts.join('#')}` : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${attr}=${quote}${base}${sep}${qs}${hash}${quote}`;
  });
}

function buildAgentHandoffRequest(entry, focusTopic) {
  const focusDirective = focusTopic
    ? `User focus / instructions / reply for the new conversation:\n"${focusTopic}"\nNote: The user may have written this as a direct reply, approval, or refinement to your very last message in this chat (instead of replying here) so that the next step runs in a fresh conversation. Scope the handoff prompt STRICTLY to executing or continuing what the user requested above, combined with the directly relevant technical context from our latest discussion.`
    : `Scope the handoff prompt strictly to the active, unfinished task or immediate next step from the latest turns of our conversation.`;

  return (
    `[AGY Cockpit Smart Handoff]\n` +
    `Create a self-contained, high-signal handoff prompt so we can continue seamlessly in a fresh conversation.\n\n` +
    `${focusDirective}\n\n` +
    `STRICT RULES:\n` +
    `1. Do NOT call any tools (no read_file, no run_command, no search). You already have all required context in memory. Respond immediately.\n` +
    `2. Write the entire handoff prompt in the SAME language the user has been using in this conversation (unless the user explicitly requested a different language above).\n` +
    `3. Wrap the final handoff prompt strictly inside <HANDOFF_PROMPT> and </HANDOFF_PROMPT> tags. As soon as you finish your response, the AGY Cockpit sidecar will automatically extract the content inside those tags and load it into the review editor.\n` +
    `4. Ignore any earlier <HANDOFF_PROMPT> blocks that may exist higher up in this conversation's history. Do NOT copy or carry over old sections from them; write a fresh, tightly scoped prompt for the current target task.\n` +
    `5. Maximize signal-to-noise ratio. Do NOT write a session changelog or historical summary of unrelated tasks that were already completed earlier in this conversation (the files on disk already reflect completed changes). Mention prior work ONLY if it is partially finished, uncommitted in a way that affects the next step, or has a direct technical dependency or side-effect on the immediate task.\n` +
    `6. Inside <HANDOFF_PROMPT>...</HANDOFF_PROMPT> include ONLY:\n` +
    `   - On the very first line, a clear instruction (in the target language) stating that all necessary context is provided below and the new agent must NOT search or read transcript.jsonl files from previous conversations.\n` +
    `   - The Workspace (${entry.workspacePath || 'current workspace'}) and ONLY the specific files (with exact function/symbol names and approximate line ranges when known) that the new agent will actually need to read or modify for this task.\n` +
    `   - The exact technical context, agreed design decisions, constraints, edge cases, and concrete action items required to execute the immediate task right away.\n` +
    `   - Do NOT include the old conversationId UUID.`
  );
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function execFileAsync(file, args, options = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true, ...options }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : '' });
    });
  });
}

class AgyCockpitServer {
  constructor(options = {}) {
    this.appDataDir = options.appDataDir || resolveAppDataDir();
    this.brainDir = options.brainDir || path.join(this.appDataDir, 'brain');
    this.dataDir = options.dataDir || resolveDataDir(this.appDataDir);
    this.projectsDir = options.projectsDir || resolveProjectsDir();
    this.uiHtmlPath = options.uiHtmlPath || path.join(__dirname, 'ui.html');

    const envPort = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '', 10);
    this.port = options.port !== undefined
      ? options.port
      : (Number.isFinite(envPort) ? envPort : DEFAULT_PORT);

    this.token =
      options.token ??
      process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ??
      process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ??
      process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ??
      '';

    this.convCache = new Map();
    this.deletedConvIds = new Set();
    this.metadataWorkspaceCache = new Map();
    this.lsTrajectoryMeta = new Map();
    this.lsCheckedMissingConvs = new Map();
    this.lsTrajectoriesFetchedAtMs = 0;
    this.lsTrajectoriesFetchPromise = null;
    this.trajectoriesInitialSyncDone = false;
    this.pendingCustomTitleSync = new Set();
    this.annotationTitleCache = new Map();
    this.annotationsDir = path.join(this.appDataDir, 'annotations');
    this.lastAnnotationsDirMtimeMs = 0;
    this.projectsRegistry = new Map();
    this.projectFileMtimes = new Map();
    this.lastProjectsCheckMs = 0;
    this.lastProjectsScanMs = 0;
    this.lastProjectsDirMtimeMs = 0;
    this.projectsRev = 1;
    this.gitCache = new GitRepoCache();
    this.stateVersion = 1;
    this.transcriptRev = 1;
    this.lastStateSignature = '';
    this.lastRefreshDurationMs = 0;
    this.lastFullScanMs = 0;
    this.lastBrainDirMtimeMs = 0;
    this.cachedIndexSummary = null;
    this.cachedCardsState = null;
    this.cachedUiMtimeMs = 0;
    this.lastUiStatCheckMs = 0;
    this.scriptChangedOnDisk = false;
    this.saveCacheTimer = null;
    this.indexCacheDirty = false;
    this.server = null;

    this.cachedModelsCatalog = { models: [], defaultModelEnum: '', fetchedAtMs: 0 };
    this.modelsFetchPromise = null;
    this.modelResolveInFlight = new Set();
    this.modelResolveCooldown = new Map();
    this.modelsCatalogRev = 1;
    this.cachedModelQuotas = [];
    this.cachedQuota = null;
    this.quotaFetchedAtMs = 0;
    this.quotaFetchPromise = null;
    this.lastQuotaSignature = '';
    this.initialBootScanDone = false;

    this.diagnosticsState = null;
    this.diagnosticsPromise = null;
    this.diagnosticsRev = 1;
    this.lastBinaryStatCheckMs = 0;
    this.lastKnownBinarySig = '';
    this.lastKnownSymbolsKey = '';

    this.pluginUpdateState = { updateAvailable: false, installedCommit: '', remoteCommit: '', checkedAtMs: 0, localDirty: false, isAhead: false, error: '' };
    this.pluginUpdateCheckPromise = null;
    this.pluginUpdateApplyPromise = null;
    this.pluginUpdateTimer = null;
    this.pluginUpdateRev = 1;
    this.lastPluginUpdateSig = '';
    this.cachedInstallMeta = null;
    this.restartingForUpdate = false;

    this.indexCachePath = path.join(this.dataDir, 'index_cache.json');
    this.metadataCachePath = path.join(this.dataDir, 'metadata_cache.json');
    this.diagnosticsCachePath = path.join(this.dataDir, 'diagnostics_cache.json');
    this.archivedDataPath = path.join(this.dataDir, 'archived.json');
    this.serverInfoPath = path.join(this.dataDir, 'server_info.json');

    this.pinnedConversations = new Map();
    this.customTitles = new Map();
    this.defaultTitles = new Map();
    this.archivedDataRaw = {
      pinnedConversations: {},
      customTitles: {},
      defaultTitles: {}
    };

    try {
      this.bootScriptMtimeMs = fs.statSync(__filename).mtimeMs;
    } catch {
      this.bootScriptMtimeMs = 0;
    }

    this.loadPersistentCaches();
  }

  loadArchivedData() {
    if (!isFile(this.archivedDataPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.archivedDataPath, 'utf-8'));
      if (!raw || typeof raw !== 'object') return;
      this.archivedDataRaw = {
        pinnedConversations: {},
        customTitles: {},
        defaultTitles: {}
      };
      this.pinnedConversations.clear();
      if (raw.pinnedConversations && typeof raw.pinnedConversations === 'object') {
        if (Array.isArray(raw.pinnedConversations)) {
          const nowMs = Date.now();
          for (const id of raw.pinnedConversations) {
            if (typeof id === 'string' && UUID_RE.test(id.trim())) {
              this.pinnedConversations.set(id.trim().toLowerCase(), nowMs);
            }
          }
        } else {
          for (const [k, v] of Object.entries(raw.pinnedConversations)) {
            const cleanId = k.trim().toLowerCase();
            if (UUID_RE.test(cleanId) && v) {
              const ts = typeof v === 'number' && v > 0 ? v : Date.now();
              this.pinnedConversations.set(cleanId, ts);
            }
          }
        }
      }
      this.customTitles.clear();
      this.pendingCustomTitleSync.clear();
      if (raw.customTitles && typeof raw.customTitles === 'object' && !Array.isArray(raw.customTitles)) {
        for (const [k, v] of Object.entries(raw.customTitles)) {
          const cleanId = k.trim().toLowerCase();
          const cleanTitle = typeof v === 'string' ? v.trim() : '';
          if (UUID_RE.test(cleanId) && cleanTitle) {
            this.customTitles.set(cleanId, cleanTitle);
            this.pendingCustomTitleSync.add(cleanId);
          }
        }
      }
      this.defaultTitles.clear();
      if (raw.defaultTitles && typeof raw.defaultTitles === 'object' && !Array.isArray(raw.defaultTitles)) {
        for (const [k, v] of Object.entries(raw.defaultTitles)) {
          const cleanId = k.trim().toLowerCase();
          const cleanDefault = typeof v === 'string' ? v.trim() : '';
          if (UUID_RE.test(cleanId) && cleanDefault) {
            this.defaultTitles.set(cleanId, cleanDefault);
          }
        }
      }
    } catch {}
  }

  saveArchivedData() {
    try {
      const pinnedObj = Object.fromEntries(this.pinnedConversations.entries());
      const titlesObj = Object.fromEntries(this.customTitles.entries());
      const defaultsObj = Object.fromEntries(this.defaultTitles.entries());
      const payload = {
        ...(this.archivedDataRaw || {}),
        pinnedConversations: pinnedObj,
        customTitles: titlesObj,
        defaultTitles: defaultsObj,
        updatedAtMs: Date.now()
      };
      this.archivedDataRaw = payload;
      writeJsonAtomic(this.archivedDataPath, payload, undefined, true);
    } catch {}
  }

  loadPersistentCaches() {
    this.loadArchivedData();
    if (isFile(this.diagnosticsCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.diagnosticsCachePath, 'utf-8'));
        if (raw && typeof raw.binarySig === 'string') {
          this.lastKnownBinarySig = raw.binarySig;
          if (typeof raw.symbolsKey === 'string' && Array.isArray(raw.foundSymbols)) {
            this.lastKnownSymbolsKey = raw.symbolsKey;
            binarySymbolCache.set(`${raw.binarySig}|${raw.symbolsKey}`, raw.foundSymbols);
          }
        }
      } catch {}
    }
    if (isFile(this.metadataCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.metadataCachePath, 'utf-8'));
        if (raw && raw.version === 2 && raw.entries && typeof raw.entries === 'object') {
          for (const [k, v] of Object.entries(raw.entries)) {
            if (v === '__general__') {
              this.metadataWorkspaceCache.set(k, '__general__');
            } else if (typeof v === 'string' && v) {
              this.metadataWorkspaceCache.set(k, resolveCanonicalWorkspace(v));
            } else if (v && typeof v === 'object') {
              const projId = typeof v.projectId === 'string' && UUID_RE.test(v.projectId.trim()) ? v.projectId.trim().toLowerCase() : '';
              const wsPath = typeof v.workspacePath === 'string' && v.workspacePath ? resolveCanonicalWorkspace(v.workspacePath) : '';
              if (projId || wsPath) {
                this.metadataWorkspaceCache.set(k, { projectId: projId, workspacePath: wsPath });
              }
            }
          }
        }
      } catch {}
    }

    if (isFile(this.indexCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexCachePath, 'utf-8'));
        if (raw && raw.version === 17 && Array.isArray(raw.entries)) {
          this.migratedUnreadFlags = new Set();
          for (const item of raw.entries) {
            if (item && typeof item.id === 'string' && item.markedAsUnread) {
              this.migratedUnreadFlags.add(item.id);
            }
          }
        } else if (raw && (raw.version === 18 || raw.version === 19) && Array.isArray(raw.entries)) {
          const isV19 = raw.version === 19;
          for (const item of raw.entries) {
            if (item && typeof item.id === 'string') {
              item.lastLineOffset = typeof item.lastLineOffset === 'number' ? item.lastLineOffset : 0;
              item.lastParsedStepIndex = typeof item.lastParsedStepIndex === 'number' ? item.lastParsedStepIndex : -1;
              item.lastPlannerStepTok = item.lastPlannerStepTok && typeof item.lastPlannerStepTok === 'object' ? item.lastPlannerStepTok : null;
              item.lastHandoffRequestStepIndex = typeof item.lastHandoffRequestStepIndex === 'number' ? item.lastHandoffRequestStepIndex : -1;
              item.lastHandoffStepIndex = typeof item.lastHandoffStepIndex === 'number' ? item.lastHandoffStepIndex : -1;
              item.lastHandoffCompletedStepIndex = typeof item.lastHandoffCompletedStepIndex === 'number' ? item.lastHandoffCompletedStepIndex : -1;
              item.handoffRpcPendingMs = 0;
              if (item.awaitingHandoffResponse && item.lastHandoffRequestStepIndex < 0 && item.lastParsedStepIndex >= 0) {
                item.lastHandoffRequestStepIndex = item.lastParsedStepIndex;
              }
              delete item.handoffUpdatedInPass;
              item.projectId = isV19 ? (item.projectId || '') : '';
              item.workspacePath = isV19 ? (item.workspacePath || '') : '';
              item.lsSummary = isV19 ? (item.lsSummary || '') : '';
              item.lastUserInputMs = item.lastUserInputMs || 0;
              item.lastSeenMs = item.lastSeenMs || 0;
              item.manualUnreadAtMs = item.manualUnreadAtMs || 0;
              item.markedAsUnread = Boolean(item.markedAsUnread);
              item.lastModelResponse = item.lastModelResponse || '';
              item.lastModelResponseMs = item.lastModelResponseMs || 0;
              item.lastStepType = item.lastStepType || '';
              item.lastStepStatus = item.lastStepStatus || '';
              item.lastStepHasToolCalls = Boolean(item.lastStepHasToolCalls);
              item.lastStepIsCompletedReply = Boolean(item.lastStepIsCompletedReply);
              item.lastStepWaitKind = item.lastStepWaitKind || '';
              item.lastStepWaitDelayMs = item.lastStepWaitDelayMs || 0;
              item.lastStepWaitToolName = item.lastStepWaitToolName || '';
              item.lastStepMs = item.lastStepMs || 0;
              item.subagentRoles = item.subagentRoles && typeof item.subagentRoles === 'object' ? item.subagentRoles : {};
              item.modelEnum = item.modelEnum || '';
              item.modelLabel = item.modelLabel || '';
              item.modelResolvedMtimeMs = item.modelResolvedMtimeMs || 0;
              rebuildSearchCorpus(item);
              this.convCache.set(item.id, item);
            }
          }
          if (this.convCache.size > 0) {
            this.initialBootScanDone = true;
          }
          if (!isV19) {
            this.scheduleSaveIndexCache();
          }
        }
      } catch {}
    }
  }

  saveIndexCache() {
    if (this.saveCacheTimer) {
      clearTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    this.indexCacheDirty = false;
    try {
      const entries = [...this.convCache.values()];
      writeJsonAtomic(this.indexCachePath, { version: 19, savedAt: Date.now(), entries });
    } catch {}
  }

  scheduleSaveIndexCache() {
    this.indexCacheDirty = true;
    if (this.saveCacheTimer) return;
    this.saveCacheTimer = setTimeout(() => {
      this.saveCacheTimer = null;
      if (this.indexCacheDirty) {
        this.saveIndexCache();
      }
    }, 8000);
    if (typeof this.saveCacheTimer.unref === 'function') {
      this.saveCacheTimer.unref();
    }
  }

  saveMetadataCache() {
    try {
      const obj = Object.fromEntries(this.metadataWorkspaceCache.entries());
      writeJsonAtomic(this.metadataCachePath, { version: 2, entries: obj });
    } catch {}
  }

  loadPreloadJs() {
    return FALLBACK_PRELOAD_JS;
  }

  markTranscriptDirty({ resetSummary = true, saveIndex = true, bumpStateVersion = false } = {}) {
    this.transcriptRev += 1;
    if (resetSummary) {
      this.cachedIndexSummary = null;
    }
    this.cachedCardsState = null;
    if (bumpStateVersion) {
      this.stateVersion += 1;
    }
    if (saveIndex) {
      this.scheduleSaveIndexCache();
    }
  }

  resolveConversationAnnotation(convId, forceStat = false) {
    const now = Date.now();
    const cached = this.annotationTitleCache.get(convId);
    if (!forceStat && cached && now - cached.checkedAtMs < 1000) {
      return cached;
    }

    const pbtxtPath = path.join(this.annotationsDir, `${convId}.pbtxt`);
    let stat;
    try {
      stat = fs.statSync(pbtxtPath, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      const emptyItem = {
        mtimeMs: 0,
        title: '',
        lastViewMs: 0,
        archived: false,
        markedAsUnread: false,
        checkedAtMs: now
      };
      this.annotationTitleCache.set(convId, emptyItem);
      return emptyItem;
    }
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      typeof cached.lastViewMs === 'number' &&
      typeof cached.archived === 'boolean' &&
      typeof cached.markedAsUnread === 'boolean'
    ) {
      cached.checkedAtMs = now;
      return cached;
    }
    try {
      const raw = fs.readFileSync(pbtxtPath, 'utf-8');
      const { title, lastViewMs, archived, markedAsUnread } = extractAnnotationFromPbtxt(raw);
      const item = {
        mtimeMs: stat.mtimeMs,
        title,
        lastViewMs,
        archived,
        markedAsUnread: Boolean(markedAsUnread),
        checkedAtMs: now
      };
      this.annotationTitleCache.set(convId, item);
      return item;
    } catch {
      return (
        cached || {
          mtimeMs: 0,
          title: '',
          lastViewMs: 0,
          archived: false,
          markedAsUnread: false,
          checkedAtMs: now
        }
      );
    }
  }

  syncTrajectoriesFromLanguageServer(force = false) {
    const now = Date.now();
    if (this.lsTrajectoriesFetchPromise) {
      return this.lsTrajectoriesFetchPromise;
    }
    if (!force && this.trajectoriesInitialSyncDone) {
      let hasUnsyncedMainConv = false;
      for (const [cid, e] of this.convCache.entries()) {
        if (!e || e.isSubagent) continue;
        if ((!this.lsTrajectoryMeta.has(cid) && this.lsCheckedMissingConvs.get(cid) !== (e.mtimeMs || 0)) || isEntryThinking(e, now) || getEntryWaitState(e, now)) {
          hasUnsyncedMainConv = true;
          break;
        }
      }
      const minIntervalMs = hasUnsyncedMainConv ? 1000 : 12000;
      if (now - this.lsTrajectoriesFetchedAtMs < minIntervalMs) {
        return Promise.resolve(false);
      }
    }
    this.lsTrajectoriesFetchedAtMs = now;
    this.lsTrajectoriesFetchPromise = (async () => {
      let anyChanged = false;
      let metaCacheDirty = false;
      try {
        this.refreshProjectsRegistry(false);
        const syncStartedAtMs = Date.now();
        const res = await callLanguageServerRpc(
          'GetAllCascadeTrajectories',
          { excludeSubtrajectories: true },
          5000
        );
        const summaries =
          (res && res.trajectorySummaries && typeof res.trajectorySummaries === 'object' && res.trajectorySummaries) ||
          (res && res.data && res.data.trajectorySummaries && typeof res.data.trajectorySummaries === 'object' && res.data.trajectorySummaries) ||
          null;
        if (!summaries) {
          this.trajectoriesInitialSyncDone = true;
          return false;
        }

        for (const [rawId, summary] of Object.entries(summaries)) {
          const cleanId = rawId.trim().toLowerCase();
          if (!UUID_RE.test(cleanId) || !summary || typeof summary !== 'object') continue;
          const trajMeta =
            summary.trajectoryMetadata && typeof summary.trajectoryMetadata === 'object'
              ? summary.trajectoryMetadata
              : {};
          const officialProjectId =
            typeof trajMeta.projectId === 'string' && UUID_RE.test(trajMeta.projectId.trim())
              ? trajMeta.projectId.trim().toLowerCase()
              : '';
          let officialWsUri = '';
          if (
            Array.isArray(trajMeta.workspaceUris) &&
            trajMeta.workspaceUris.length > 0 &&
            typeof trajMeta.workspaceUris[0] === 'string'
          ) {
            officialWsUri = trajMeta.workspaceUris[0];
          } else if (
            Array.isArray(trajMeta.workspaces) &&
            trajMeta.workspaces.length > 0 &&
            trajMeta.workspaces[0] &&
            typeof trajMeta.workspaces[0].workspaceFolderAbsoluteUri === 'string'
          ) {
            officialWsUri = trajMeta.workspaces[0].workspaceFolderAbsoluteUri;
          }

          let resolvedWsPath = '';
          if (this.projectsRegistry.size > 0) {
            if (officialProjectId) {
              const proj = this.projectsRegistry.get(officialProjectId);
              resolvedWsPath =
                (proj && proj.primaryPath) ||
                (officialWsUri ? resolveCanonicalWorkspace(officialWsUri) : '');
            } else {
              resolvedWsPath = '';
            }
          } else if (officialWsUri) {
            resolvedWsPath = resolveCanonicalWorkspace(officialWsUri);
          }

          const lsSummary = typeof summary.summary === 'string' ? summary.summary.trim() : '';
          const annotTitle =
            summary.annotations && typeof summary.annotations.title === 'string'
              ? summary.annotations.title.trim()
              : '';

          this.lsTrajectoryMeta.set(cleanId, {
            projectId: officialProjectId,
            workspacePath: resolvedWsPath,
            summary: lsSummary,
            annotTitle
          });
          this.lsCheckedMissingConvs.delete(cleanId);

          const nextCacheVal =
            officialProjectId || resolvedWsPath
              ? { projectId: officialProjectId, workspacePath: resolvedWsPath }
              : '__general__';
          const prevCacheVal = this.metadataWorkspaceCache.get(cleanId);
          const cacheSame =
            nextCacheVal === '__general__'
              ? prevCacheVal === '__general__'
              : Boolean(
                  prevCacheVal &&
                  typeof prevCacheVal === 'object' &&
                  prevCacheVal.projectId === nextCacheVal.projectId &&
                  prevCacheVal.workspacePath === nextCacheVal.workspacePath
                );
          if (!cacheSame) {
            this.metadataWorkspaceCache.set(cleanId, nextCacheVal);
            metaCacheDirty = true;
          }

          const entry = this.convCache.get(cleanId);
          if (entry && !entry.isSubagent) {
            if ((entry.projectId || '') !== officialProjectId) {
              entry.projectId = officialProjectId;
              anyChanged = true;
            }
            if ((entry.workspacePath || '') !== resolvedWsPath) {
              entry.workspacePath = resolvedWsPath;
              anyChanged = true;
            }
            if (lsSummary && entry.lsSummary !== lsSummary) {
              entry.lsSummary = lsSummary;
              anyChanged = true;
            }
            const effectiveTitle = annotTitle || lsSummary;
            if (!entry.title && effectiveTitle) {
              entry.title = effectiveTitle;
              rebuildSearchCorpus(entry);
              anyChanged = true;
            }
            const lastAct = Math.max(entry.mtimeMs || 0, entry.lastStepMs || 0, entry.lastUserInputMs || 0);
            const idleGraceMs = summary.latestExecutorTerminationReason === 'EXECUTOR_TERMINATION_REASON_USER_CANCELED' ? 0 : 1500;
            if (
              (isEntryThinking(entry, syncStartedAtMs) || getEntryWaitState(entry, syncStartedAtMs)) &&
              (summary.status === 'CASCADE_RUN_STATUS_CANCELING' ||
                (summary.status === 'CASCADE_RUN_STATUS_IDLE' && !summary.waitingSteps?.length && syncStartedAtMs >= lastAct + idleGraceMs))
            ) {
              entry.lastStepStatus = 'CANCELED';
              entry.awaitingHandoffResponse = false;
              entry.handoffRpcPendingMs = 0;
              anyChanged = true;
            }
          }
        }

        for (const [cid, e] of this.convCache.entries()) {
          if (!e || e.isSubagent) continue;
          if (!this.lsTrajectoryMeta.has(cid)) {
            this.lsCheckedMissingConvs.set(cid, e.mtimeMs || 0);
          }
        }

        if (this.pendingCustomTitleSync && this.pendingCustomTitleSync.size > 0) {
          const pendingIds = [...this.pendingCustomTitleSync];
          for (const cid of pendingIds) {
            const cTitle = this.customTitles.get(cid);
            if (!cTitle) {
              this.pendingCustomTitleSync.delete(cid);
              continue;
            }
            const lsMeta = this.lsTrajectoryMeta.get(cid);
            const annot = this.resolveConversationAnnotation(cid, false);
            if (annot.title !== cTitle || (lsMeta && lsMeta.annotTitle !== cTitle)) {
              await this.setConversationCustomTitle(cid, cTitle);
              anyChanged = true;
            }
            this.pendingCustomTitleSync.delete(cid);
          }
        }

        this.trajectoriesInitialSyncDone = true;
        if (metaCacheDirty) {
          this.saveMetadataCache();
        }
        if (anyChanged) {
          this.markTranscriptDirty({ resetSummary: false, saveIndex: true, bumpStateVersion: true });
        }
      } catch {} finally {
        this.lsTrajectoriesFetchedAtMs = Date.now();
        this.lsTrajectoriesFetchPromise = null;
      }
      return anyChanged;
    })();
    return this.lsTrajectoriesFetchPromise;
  }

  applyEntryMetadata(entry, convId, activeConvId = '', activeWorkspaceNorm = '', forceAnnot = false) {
    let changed = false;
    const lsMeta = this.lsTrajectoryMeta.get(convId);
    if (!entry.isSubagent) {
      const annot = this.resolveConversationAnnotation(convId, forceAnnot);
      if (lsMeta && lsMeta.summary && entry.lsSummary !== lsMeta.summary) {
        entry.lsSummary = lsMeta.summary;
        changed = true;
      }
      const existingCustom = this.customTitles.get(convId) || '';
      const savedDefault = this.defaultTitles.get(convId) || '';
      if (
        annot.title &&
        existingCustom &&
        annot.title !== existingCustom &&
        annot.title !== savedDefault &&
        !(this.pendingCustomTitleSync && this.pendingCustomTitleSync.has(convId))
      ) {
        this.customTitles.set(convId, annot.title);
        this.saveArchivedData();
        changed = true;
      }
      const effectiveTitle =
        annot.title ||
        (lsMeta && lsMeta.annotTitle) ||
        (lsMeta && lsMeta.summary) ||
        '';
      if (effectiveTitle && entry.title !== effectiveTitle) {
        entry.title = effectiveTitle;
        rebuildSearchCorpus(entry);
        changed = true;
      }
      // last_user_view_time is stamped with the SAME value on both chats of every switch (left and
      // entered) and again while the user interacts with the open chat. It means "the user was around
      // this chat at T", not "this chat is open now"; never infer the open chat from max(lastViewMs).
      if (annot.lastViewMs && annot.lastViewMs > (entry.lastViewMs || 0)) {
        this.debugTrace({ ev: 'annotView', id: convId.slice(0, 8), from: entry.lastViewMs || 0, to: annot.lastViewMs });
        entry.lastViewMs = annot.lastViewMs;
        changed = true;
      }
      const nextArchived = Boolean(annot.archived);
      if (Boolean(entry.archived) !== nextArchived) {
        entry.archived = nextArchived;
        changed = true;
      }
      if (entry.manualUnreadAtMs > 0) {
        const clearedByActivity =
          (entry.lastSeenMs || 0) >= entry.manualUnreadAtMs ||
          (entry.lastViewMs || 0) >= entry.manualUnreadAtMs ||
          (entry.lastUserInputMs || 0) >= entry.manualUnreadAtMs ||
          ((annot.mtimeMs || 0) > entry.manualUnreadAtMs && !annot.markedAsUnread);
        if (clearedByActivity) {
          entry.manualUnreadAtMs = 0;
          changed = true;
        }
      }
      const nextUnreadFlag = Boolean(
        entry.manualUnreadAtMs > 0 ||
        (annot.markedAsUnread && (annot.mtimeMs || 0) > (entry.lastSeenMs || 0))
      );
      if (Boolean(entry.markedAsUnread) !== nextUnreadFlag) {
        entry.markedAsUnread = nextUnreadFlag;
        changed = true;
      }
    }
    if (lsMeta) {
      const nextProjId = lsMeta.projectId || '';
      const nextWsPath = lsMeta.workspacePath || '';
      if ((entry.projectId || '') !== nextProjId) {
        entry.projectId = nextProjId;
        changed = true;
      }
      if ((entry.workspacePath || '') !== nextWsPath) {
        entry.workspacePath = nextWsPath;
        changed = true;
      }
    } else {
      const cachedMeta = this.metadataWorkspaceCache.get(convId);
      if (cachedMeta === '__general__') {
        if (entry.projectId || entry.workspacePath) {
          entry.projectId = '';
          entry.workspacePath = '';
          changed = true;
        }
      } else if (cachedMeta && typeof cachedMeta === 'object') {
        const nextProjId = cachedMeta.projectId || '';
        const nextWsPath = cachedMeta.workspacePath || '';
        if ((entry.projectId || '') !== nextProjId) {
          entry.projectId = nextProjId;
          changed = true;
        }
        if ((entry.workspacePath || '') !== nextWsPath) {
          entry.workspacePath = nextWsPath;
          changed = true;
        }
      } else if (typeof cachedMeta === 'string' && cachedMeta) {
        if (!entry.workspacePath) {
          entry.workspacePath = cachedMeta;
          changed = true;
        }
      } else if (this.trajectoriesInitialSyncDone && this.projectsRegistry.size > 0 && (entry.workspacePath || entry.projectId)) {
        entry.projectId = '';
        entry.workspacePath = '';
        changed = true;
      }
    }
    return changed;
  }

  // Opt-in unread/claim tracing. Enabled while <appDataDir>/scratch/agy-cockpit-trace.on exists; records
  // go to agy-cockpit-trace.jsonl next to it (a directory agents can read from their sandbox). The UI
  // learns the state through traceEnabled in /api/status and posts its own records to /api/debug-trace.
  // See "Unread / Blue Dot Debugging" in AGENTS.md.
  isTraceEnabled() {
    const now = Date.now();
    if (now - (this.traceCheckedAtMs || 0) < 2000) return Boolean(this.traceEnabled);
    this.traceCheckedAtMs = now;
    const dir = path.join(this.appDataDir, 'scratch');
    this.traceFile = path.join(dir, 'agy-cockpit-trace.jsonl');
    this.traceEnabled = isFile(path.join(dir, 'agy-cockpit-trace.on'));
    if (this.traceEnabled) {
      try {
        const size = fs.statSync(this.traceFile, { throwIfNoEntry: false })?.size || 0;
        if (size > 20 * 1024 * 1024) fs.renameSync(this.traceFile, this.traceFile + '.1');
      } catch {}
    }
    return this.traceEnabled;
  }

  debugTrace(rec) {
    if (!this.isTraceEnabled()) return;
    try {
      fs.appendFileSync(this.traceFile, JSON.stringify(Object.assign({ src: 'server', t: Date.now() }, rec)) + '\n');
    } catch {}
  }

  clearConversationUnreadAnnotation(cleanId) {
    const pbtxtPath = path.join(this.annotationsDir, `${cleanId}.pbtxt`);
    try {
      if (isFile(pbtxtPath)) {
        const existingRaw = fs.readFileSync(pbtxtPath, 'utf-8');
        const parsed = existingRaw ? extractAnnotationFromPbtxt(existingRaw) : null;
        if (parsed && parsed.markedAsUnread) {
          let updatedRaw = existingRaw.replace(/^\s*marked_as_unread\s*:\s*(?:true|false)\s*$/gim, '').trim();
          if (updatedRaw) updatedRaw += '\n';
          fs.writeFileSync(pbtxtPath, updatedRaw, 'utf-8');
          this.annotationTitleCache.delete(cleanId);
          this.resolveConversationAnnotation(cleanId, true);
        }
      }
    } catch {}
    void callLanguageServerRpc(
      'UpdateConversationAnnotations',
      {
        cascadeId: cleanId,
        annotations: { markedAsUnread: false },
        mergeAnnotations: true
      },
      4000
    ).catch(() => {});
  }

  markConversationSeen(convId, bumpViewTime = false) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) return false;
    const entry = this.convCache.get(cleanId);
    if (!entry) return false;
    if (this.isTraceEnabled()) {
      this.debugTrace({
        ev: 'markSeen', id: cleanId.slice(0, 8), bump: bumpViewTime,
        lastSeenMs: entry.lastSeenMs || 0, lastViewMs: entry.lastViewMs || 0,
        lastModelResponseMs: entry.lastModelResponseMs || 0,
        caller: (new Error().stack || '').split('\n')[2]?.trim() || ''
      });
    }
    let changed = false;
    if (bumpViewTime) {
      const nowMs = Date.now();
      if (nowMs > (entry.lastViewMs || 0)) {
        entry.lastViewMs = nowMs;
        changed = true;
      }
    }
    // Strip marked_as_unread from .pbtxt BEFORE reading annot.mtimeMs into targetMs below. Otherwise:
    // (1) the .pbtxt rewrite itself would leave annot.mtimeMs > lastSeenMs, and (2) when Antigravity
    // stamps last_user_view_time ~60 ms after a Cockpit open-chat click, a leftover marked_as_unread: true
    // in .pbtxt would satisfy annot.mtimeMs > lastSeenMs in applyEntryMetadata and re-light the dot.
    const prevAnnot = this.annotationTitleCache.get(cleanId);
    if (entry.markedAsUnread || entry.manualUnreadAtMs > 0 || (prevAnnot && prevAnnot.markedAsUnread)) {
      this.clearConversationUnreadAnnotation(cleanId);
    }
    const annot = this.annotationTitleCache.get(cleanId);
    const targetMs = Math.max(
      entry.lastSeenMs || 0,
      entry.lastViewMs || 0,
      entry.lastUserInputMs || 0,
      entry.lastModelResponseMs || 0,
      entry.manualUnreadAtMs || 0,
      annot && annot.mtimeMs ? Math.ceil(annot.mtimeMs) : 0
    );
    if (targetMs > (entry.lastSeenMs || 0)) {
      entry.lastSeenMs = targetMs;
      changed = true;
    }
    if (entry.manualUnreadAtMs) {
      entry.manualUnreadAtMs = 0;
      changed = true;
    }
    if (entry.markedAsUnread) {
      entry.markedAsUnread = false;
      changed = true;
    }
    if (changed) {
      this.markTranscriptDirty({ resetSummary: false, saveIndex: true });
    }
    return changed;
  }

  async setConversationUnread(convId, unread) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const nextUnread = Boolean(unread);
    if (this.isTraceEnabled()) {
      this.debugTrace({ ev: 'setUnread', id: cleanId.slice(0, 8), unread: nextUnread });
    }
    if (!nextUnread) {
      this.markConversationSeen(cleanId, true);
      this.clearConversationUnreadAnnotation(cleanId);
      this.markTranscriptDirty({ resetSummary: false, saveIndex: true, bumpStateVersion: true });
      return {
        status: 200,
        body: {
          ok: true,
          conversationId: cleanId,
          unread: false
        }
      };
    }

    const pbtxtPath = path.join(this.annotationsDir, `${cleanId}.pbtxt`);
    let existingRaw = '';
    try {
      if (isFile(pbtxtPath)) {
        existingRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
    } catch {}

    try {
      await callLanguageServerRpc(
        'UpdateConversationAnnotations',
        {
          cascadeId: cleanId,
          annotations: {
            markedAsUnread: true
          },
          mergeAnnotations: true
        },
        4000
      );
    } catch {}

    try {
      let postRpcRaw = existingRaw;
      if (isFile(pbtxtPath)) {
        postRpcRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
      fs.mkdirSync(this.annotationsDir, { recursive: true });
      let updatedRaw = (postRpcRaw || '').replace(/^\s*marked_as_unread\s*:\s*(?:true|false)\s*$/gim, '').trim();
      updatedRaw = (updatedRaw ? updatedRaw + '\n' : '') + 'marked_as_unread: true\n';
      fs.writeFileSync(pbtxtPath, updatedRaw, 'utf-8');
    } catch {}

    this.annotationTitleCache.delete(cleanId);
    const annot = this.resolveConversationAnnotation(cleanId, true);
    const entry = this.convCache.get(cleanId);
    if (entry) {
      // Keep lastSeenMs >= minBaselineMs (so if the user later clicks "Mark as read" in the native side
      // nav, which only removes marked_as_unread from .pbtxt without bumping last_user_view_time, an old
      // reply does not stay unread), while clamping <= annot.mtimeMs - 1 so applyEntryMetadata's
      // (annot.mtimeMs > lastSeenMs) check stays true.
      const minBaselineMs = Math.max(
        entry.lastModelResponseMs || 0,
        entry.lastViewMs || 0,
        entry.lastUserInputMs || 0
      );
      const markMs = Math.max(
        Date.now(),
        annot && annot.mtimeMs ? Math.ceil(annot.mtimeMs) : 0,
        minBaselineMs + 1
      );
      const maxFloorMs = annot && annot.mtimeMs > 0 ? Math.floor(annot.mtimeMs) - 1 : markMs - 1;
      entry.lastSeenMs = Math.min(Math.max(entry.lastSeenMs || 0, minBaselineMs), maxFloorMs);
      entry.manualUnreadAtMs = markMs;
      entry.markedAsUnread = true;
    }
    this.markTranscriptDirty({ resetSummary: false, saveIndex: true, bumpStateVersion: true });
    return {
      status: 200,
      body: {
        ok: true,
        conversationId: cleanId,
        unread: true
      }
    };
  }

  async setConversationArchived(convId, archived) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const nextArchived = Boolean(archived);
    const pbtxtPath = path.join(this.annotationsDir, `${cleanId}.pbtxt`);
    let existingRaw = '';
    try {
      if (isFile(pbtxtPath)) {
        existingRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
    } catch {}
    const parsedAnnot = existingRaw ? extractAnnotationFromPbtxt(existingRaw) : { title: '', lastViewMs: 0 };
    const entry = this.convCache.get(cleanId);
    const effectiveTitle = parsedAnnot.title || (entry && entry.title) || '';
    const lastViewIso = parsedAnnot.lastViewMs > 0
      ? new Date(parsedAnnot.lastViewMs).toISOString()
      : new Date().toISOString();

    try {
      if (nextArchived) {
        await callLanguageServerRpc(
          'UpdateConversationAnnotations',
          {
            cascadeId: cleanId,
            annotations: {
              archived: true,
              archivalStatusTimestamp: new Date().toISOString()
            },
            mergeAnnotations: true
          },
          4000
        );
      } else {
        await callLanguageServerRpc(
          'UpdateConversationAnnotations',
          {
            cascadeId: cleanId,
            annotations: {
              ...(effectiveTitle ? { title: effectiveTitle } : {}),
              lastUserViewTime: lastViewIso,
              archived: false
            },
            mergeAnnotations: false
          },
          4000
        );
      }
    } catch {}

    try {
      let postRpcRaw = existingRaw;
      if (isFile(pbtxtPath)) {
        postRpcRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
      const postRpcAnnot = postRpcRaw ? extractAnnotationFromPbtxt(postRpcRaw) : null;
      if (!postRpcAnnot || Boolean(postRpcAnnot.archived) !== nextArchived) {
        fs.mkdirSync(this.annotationsDir, { recursive: true });
        let updatedRaw = (postRpcRaw || '').replace(/^\s*archived\s*:\s*(?:true|false)\s*$/gim, '').trim();
        if (nextArchived) {
          updatedRaw = (updatedRaw ? updatedRaw + '\n' : '') + 'archived: true\n';
        } else if (updatedRaw) {
          updatedRaw = updatedRaw + '\n';
        }
        if (updatedRaw || isFile(pbtxtPath)) {
          fs.writeFileSync(pbtxtPath, updatedRaw, 'utf-8');
        }
      }
    } catch {}

    this.annotationTitleCache.delete(cleanId);
    if (entry) {
      entry.archived = nextArchived;
    }
    this.markTranscriptDirty();
    return {
      status: 200,
      body: {
        ok: true,
        conversationId: cleanId,
        archived: nextArchived
      }
    };
  }

  async deleteConversation(convId) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    let rpcResult = null;
    try {
      rpcResult = await callLanguageServerRpc(
        'DeleteCascadeTrajectory',
        { cascadeId: cleanId },
        6000
      );
    } catch (err) {
      rpcResult = { error: err instanceof Error ? err.message : String(err) };
    }

    const targets = [
      path.join(this.brainDir, cleanId),
      path.join(this.appDataDir, 'conversations', `${cleanId}.pb`),
      path.join(this.annotationsDir, `${cleanId}.pbtxt`)
    ];
    for (const target of targets) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {}
    }

    this.convCache.delete(cleanId);
    this.deletedConvIds.add(cleanId);
    this.lsTrajectoryMeta.delete(cleanId);
    this.lsCheckedMissingConvs.delete(cleanId);
    if (this.pendingCustomTitleSync) {
      this.pendingCustomTitleSync.delete(cleanId);
    }
    if (this.metadataWorkspaceCache.delete(cleanId)) {
      this.saveMetadataCache();
    }
    this.annotationTitleCache.delete(cleanId);
    const hadPin = this.pinnedConversations.delete(cleanId);
    const hadTitle = this.customTitles.delete(cleanId);
    const hadDefault = this.defaultTitles.delete(cleanId);
    if (hadPin || hadTitle || hadDefault) {
      this.saveArchivedData();
    }
    this.lastFullScanMs = 0;
    this.lastBrainDirMtimeMs = 0;
    this.markTranscriptDirty();

    return {
      status: 200,
      body: {
        ok: true,
        conversationId: cleanId,
        rpcOk: Boolean(!rpcResult || !rpcResult.error)
      }
    };
  }

  setConversationPinned(convId, pinned) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const nextPinned = Boolean(pinned);
    let pinnedAtMs = 0;
    if (nextPinned) {
      pinnedAtMs = Date.now();
      this.pinnedConversations.set(cleanId, pinnedAtMs);
    } else {
      this.pinnedConversations.delete(cleanId);
    }
    this.saveArchivedData();
    this.markTranscriptDirty({ resetSummary: false, saveIndex: false, bumpStateVersion: true });
    return {
      status: 200,
      body: {
        ok: true,
        id: cleanId,
        conversationId: cleanId,
        pinned: nextPinned,
        pinnedAtMs
      }
    };
  }

  resolveEntryDisplayMeta(entry) {
    const rawProjId = (entry && entry.projectId) || '';
    const rawWsPath = (entry && entry.workspacePath) || '';
    const matchedProj =
      (rawProjId && this.projectsRegistry.get(rawProjId)) ||
      this.matchProjectForWorkspace(rawWsPath);
    const effectiveWsPath = matchedProj
      ? (matchedProj.primaryPath || rawWsPath)
      : rawWsPath;
    const effectiveWsKey = matchedProj
      ? (matchedProj.primaryKey || workspaceComparisonKey(effectiveWsPath))
      : workspaceComparisonKey(effectiveWsPath);
    const effectiveWsName = matchedProj
      ? matchedProj.name
      : getWorkspaceLabel(effectiveWsPath);
    const customTitle = (entry && this.customTitles.get(entry.id)) || '';
    const savedDefault = (entry && this.defaultTitles.get(entry.id)) || '';
    const baseDefault = entry
      ? (savedDefault ||
         (entry.lsSummary && entry.lsSummary !== customTitle && entry.lsSummary) ||
         (entry.title && entry.title !== customTitle && entry.title) ||
         entry.firstPrompt ||
         entry.lastPrompt ||
         entry.title ||
         ('Conversation ' + entry.id.slice(0, 8)))
      : '';
    return {
      matchedProj,
      projectId: matchedProj ? matchedProj.id : rawProjId,
      workspacePath: effectiveWsPath,
      workspaceKey: effectiveWsKey,
      workspaceName: effectiveWsName,
      customTitle,
      defaultTitle: baseDefault,
      title: customTitle || (entry && entry.title) || ''
    };
  }

  async setConversationCustomTitle(convId, title) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (this.pendingCustomTitleSync) {
      this.pendingCustomTitleSync.delete(cleanId);
    }

    const entry = this.convCache.get(cleanId);
    const lsMeta = this.lsTrajectoryMeta.get(cleanId);
    const prevCustom = this.customTitles.get(cleanId) || '';

    const pbtxtPath = path.join(this.annotationsDir, `${cleanId}.pbtxt`);
    let existingRaw = '';
    try {
      if (isFile(pbtxtPath)) {
        existingRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
    } catch {}
    const preAnnot = existingRaw ? extractAnnotationFromPbtxt(existingRaw) : { title: '' };

    if (cleanTitle) {
      if (!this.defaultTitles.has(cleanId)) {
        const origCandidate =
          (preAnnot.title && preAnnot.title !== cleanTitle && preAnnot.title !== prevCustom && preAnnot.title) ||
          (entry && entry.title && entry.title !== cleanTitle && entry.title !== prevCustom && entry.title) ||
          (lsMeta && lsMeta.summary && lsMeta.summary !== cleanTitle && lsMeta.summary !== prevCustom && lsMeta.summary) ||
          '';
        if (origCandidate) {
          this.defaultTitles.set(cleanId, origCandidate);
        }
      }
      this.customTitles.set(cleanId, cleanTitle);
    } else {
      this.customTitles.delete(cleanId);
    }

    const savedDefault = this.defaultTitles.get(cleanId) || '';
    if (!cleanTitle) {
      this.defaultTitles.delete(cleanId);
    }
    this.saveArchivedData();

    const fallbackTitle =
      savedDefault ||
      (entry && entry.lsSummary && entry.lsSummary !== prevCustom ? entry.lsSummary : '') ||
      (lsMeta && lsMeta.summary && lsMeta.summary !== prevCustom ? lsMeta.summary : '') ||
      (entry && entry.firstPrompt ? entry.firstPrompt.split('\n')[0].trim().slice(0, 100) : '') ||
      '';
    const targetOfficialTitle = cleanTitle || fallbackTitle;

    try {
      await callLanguageServerRpc(
        'UpdateConversationAnnotations',
        {
          cascadeId: cleanId,
          annotations: {
            title: targetOfficialTitle
          },
          mergeAnnotations: true
        },
        4000
      );
    } catch {}

    try {
      let postRpcRaw = existingRaw;
      if (isFile(pbtxtPath)) {
        postRpcRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
      const postRpcAnnot = postRpcRaw ? extractAnnotationFromPbtxt(postRpcRaw) : null;
      if (!postRpcAnnot || (postRpcAnnot.title || '') !== targetOfficialTitle) {
        fs.mkdirSync(this.annotationsDir, { recursive: true });
        let updatedRaw = (postRpcRaw || '').replace(/\btitle\s*:\s*"(?:[^"\\]|\\.)*"\s*/g, '').trim();
        if (targetOfficialTitle) {
          const encodedTitle = encodePbtxtString(targetOfficialTitle);
          updatedRaw = `title: "${encodedTitle}"` + (updatedRaw ? `\n${updatedRaw}` : '') + '\n';
        } else if (updatedRaw) {
          updatedRaw = updatedRaw + '\n';
        }
        if (updatedRaw || isFile(pbtxtPath)) {
          fs.writeFileSync(pbtxtPath, updatedRaw, 'utf-8');
        }
      }
    } catch {}

    this.annotationTitleCache.delete(cleanId);
    this.resolveConversationAnnotation(cleanId, true);
    if (lsMeta) {
      lsMeta.annotTitle = targetOfficialTitle;
    }
    if (entry) {
      entry.title = targetOfficialTitle || entry.lsSummary || entry.title || '';
      rebuildSearchCorpus(entry);
    }
    this.markTranscriptDirty({ resetSummary: false, saveIndex: true, bumpStateVersion: true });
    const meta = this.resolveEntryDisplayMeta(entry);
    return {
      status: 200,
      body: {
        ok: true,
        id: cleanId,
        conversationId: cleanId,
        customTitle: cleanTitle,
        title: meta.title || cleanTitle || targetOfficialTitle,
        defaultTitle: meta.defaultTitle
      }
    };
  }

  refreshProjectsRegistry(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProjectsCheckMs < 2000) {
      return;
    }
    this.lastProjectsCheckMs = now;

    let dirStat = null;
    try {
      dirStat = fs.statSync(this.projectsDir, { throwIfNoEntry: false });
    } catch {}

    if (!dirStat || !dirStat.isDirectory()) {
      this.lastProjectsDirMtimeMs = 0;
      if (this.projectsRegistry.size > 0) {
        this.projectsRegistry.clear();
        this.projectFileMtimes.clear();
        knownProjectRootPaths.clear();
        gitRootLookupCache.clear();
        this.projectsRev += 1;
        this.cachedCardsState = null;
      }
      return;
    }

    if (
      !force &&
      this.projectsRegistry.size > 0 &&
      dirStat.mtimeMs === this.lastProjectsDirMtimeMs &&
      now - this.lastProjectsScanMs < 15000
    ) {
      return;
    }
    this.lastProjectsDirMtimeMs = dirStat.mtimeMs;
    this.lastProjectsScanMs = now;

    let dirents = [];
    try {
      dirents = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return;
    }

    let changed = false;
    const seenIds = new Set();

    for (const d of dirents) {
      if (!d.isFile() || !d.name.toLowerCase().endsWith('.json')) continue;
      const projId = d.name.slice(0, -5).toLowerCase();
      if (!UUID_RE.test(projId)) continue;
      seenIds.add(projId);

      const filePath = path.join(this.projectsDir, d.name);
      let fStat = null;
      try {
        fStat = fs.statSync(filePath, { throwIfNoEntry: false });
      } catch {}
      if (!fStat || !fStat.isFile()) continue;

      const prevMtime = this.projectFileMtimes.get(projId);
      if (!force && prevMtime === fStat.mtimeMs && this.projectsRegistry.has(projId)) {
        continue;
      }

      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw || typeof raw !== 'object') continue;
        const resources = extractProjectResourcePaths(raw);
        const primary = resources[0] || { path: '', key: '', label: '' };
        const name = (typeof raw.name === 'string' && raw.name.trim()) || primary.label || projId;
        this.projectsRegistry.set(projId, {
          id: projId,
          name,
          archived: Boolean(raw.archived),
          isWorkspaceOnly: Boolean(raw.isWorkspaceOnly),
          resources,
          primaryPath: primary.path,
          primaryKey: primary.key || projId
        });
        this.projectFileMtimes.set(projId, fStat.mtimeMs);
        changed = true;
      } catch {}
    }

    for (const oldId of this.projectsRegistry.keys()) {
      if (!seenIds.has(oldId)) {
        this.projectsRegistry.delete(oldId);
        this.projectFileMtimes.delete(oldId);
        changed = true;
      }
    }

    if (changed) {
      knownProjectRootPaths.clear();
      for (const proj of this.projectsRegistry.values()) {
        for (const r of proj.resources || []) {
          if (r && r.key && r.path) {
            knownProjectRootPaths.set(r.key, r.path);
          }
        }
      }
      gitRootLookupCache.clear();
      this.projectsRev += 1;
      this.cachedCardsState = null;
    }
  }

  matchProjectForWorkspace(workspacePath) {
    if (!workspacePath || this.projectsRegistry.size === 0) return null;
    const wsKey = workspaceComparisonKey(normalizeWorkspacePath(workspacePath));
    if (!wsKey) return null;

    let bestProj = null;
    let bestKeyLen = -1;
    let bestResIdx = 9999;
    let bestNameMatch = 0;

    for (const proj of this.projectsRegistry.values()) {
      if (!Array.isArray(proj.resources)) continue;
      const projNameLower = (proj.name || '').toLowerCase();
      for (let i = 0; i < proj.resources.length; i++) {
        const res = proj.resources[i];
        if (!res || !res.key) continue;
        if (wsKey === res.key || wsKey.startsWith(res.key + '/')) {
          const keyLen = res.key.length;
          const nameMatch = (res.label || '').toLowerCase() === projNameLower ? 1 : 0;
          const isBetter =
            keyLen > bestKeyLen ||
            (keyLen === bestKeyLen && i < bestResIdx) ||
            (keyLen === bestKeyLen && i === bestResIdx && nameMatch > bestNameMatch);
          if (isBetter) {
            bestProj = proj;
            bestKeyLen = keyLen;
            bestResIdx = i;
            bestNameMatch = nameMatch;
          }
        }
      }
    }
    return bestProj;
  }

  setProjectArchived(projectId, archived) {
    const cleanId = (projectId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid project id' } };
    }
    const filePath = path.join(this.projectsDir, `${cleanId}.json`);
    if (!isFile(filePath)) {
      return { status: 404, body: { error: 'Project file not found' } };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!raw || typeof raw !== 'object') {
        return { status: 500, body: { error: 'Malformed project file' } };
      }
      const nextArchived = Boolean(archived);
      if (nextArchived) {
        raw.archived = true;
      } else {
        delete raw.archived;
      }
      writeJsonAtomic(filePath, raw, undefined, true);
      this.refreshProjectsRegistry(true);
      this.cachedCardsState = null;
      return {
        status: 200,
        body: {
          ok: true,
          projectId: cleanId,
          archived: nextArchived,
          name: raw.name || ''
        }
      };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) }
      };
    }
  }

  refreshSingleEntry(convId) {
    if (!UUID_RE.test(convId)) return null;
    if (this.refreshEntryById(convId, '', '', true)) {
      this.markTranscriptDirty();
    }
    return this.convCache.get(convId) || null;
  }

  refreshEntryById(convId, activeConvId, activeWorkspaceNorm, forceAnnot) {
    const transcriptPath = path.join(this.brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    let stat;
    try {
      stat = fs.statSync(transcriptPath, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) return false;

    const existing = this.convCache.get(convId);
    const res = updateTranscriptEntry(convId, transcriptPath, existing, stat);
    if (!res) return false;

    const entry = res.entry;
    const metaChanged = this.applyEntryMetadata(entry, convId, activeConvId, activeWorkspaceNorm, forceAnnot);
    this.convCache.set(convId, entry);
    return res.changed || metaChanged;
  }

  refreshIndex(options = {}) {
    const startNs = process.hrtime.bigint();
    const force = Boolean(options.force);
    const activeConvId = (options.activeConvId || '').trim().toLowerCase();
    const activeWorkspaceUris = Array.isArray(options.workspaceUris) ? options.workspaceUris : [];
    const activeWorkspaceNorm = activeWorkspaceUris.length > 0
      ? resolveCanonicalWorkspace(activeWorkspaceUris[0])
      : '';
    const activeWsKey = workspaceComparisonKey(activeWorkspaceNorm);

    let anyTranscriptChanged = false;
    const now = Date.now();

    let brainStat = null;
    try {
      brainStat = fs.statSync(this.brainDir, { throwIfNoEntry: false });
    } catch {}

    let annotDirMtimeMs = 0;
    try {
      annotDirMtimeMs = fs.statSync(this.annotationsDir, { throwIfNoEntry: false })?.mtimeMs || 0;
    } catch {}

    if (brainStat && brainStat.isDirectory()) {
      const brainMtimeMs = brainStat.mtimeMs || 0;
      const doFullScan =
        force ||
        this.convCache.size === 0 ||
        now - this.lastFullScanMs >= 15000 ||
        (brainMtimeMs > 0 && brainMtimeMs !== this.lastBrainDirMtimeMs);

      if (doFullScan) {
        this.lastFullScanMs = now;
        this.lastBrainDirMtimeMs = brainMtimeMs;
        this.lastAnnotationsDirMtimeMs = annotDirMtimeMs;

        let dirents = [];
        try {
          dirents = fs.readdirSync(this.brainDir, { withFileTypes: true });
        } catch {}

        const seenIds = new Set();
        const isFirstBootScan = !this.initialBootScanDone;
        for (const d of dirents) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          const convId = d.name.toLowerCase();
          if (!UUID_RE.test(convId)) continue;
          seenIds.add(convId);
          const existing = this.convCache.get(convId);
          const inActiveWs =
            !activeWsKey ||
            !existing ||
            !existing.workspacePath ||
            workspaceComparisonKey(existing.workspacePath) === activeWsKey;
          if (this.refreshEntryById(convId, activeConvId, activeWorkspaceNorm, force || convId === activeConvId || inActiveWs)) {
            anyTranscriptChanged = true;
          }
          if (isFirstBootScan) {
            const loaded = this.convCache.get(convId);
            if (loaded) {
              if (this.migratedUnreadFlags && this.migratedUnreadFlags.has(convId)) {
                loaded.markedAsUnread = true;
              } else if (!loaded.lastSeenMs) {
                loaded.lastSeenMs = Math.max(
                  loaded.lastViewMs || 0,
                  loaded.lastUserInputMs || 0,
                  loaded.lastModelResponseMs || 0
                );
              }
            }
          }
        }
        this.initialBootScanDone = true;
        this.migratedUnreadFlags = null;

        for (const [cachedId, cachedEntry] of this.convCache.entries()) {
          if (!seenIds.has(cachedId)) {
            if (
              cachedEntry &&
              !this.deletedConvIds.has(cachedId) &&
              now - (cachedEntry.lastUserInputMs || 0) < 60000 &&
              this.metadataWorkspaceCache.has(cachedId)
            ) {
              continue;
            }
            this.convCache.delete(cachedId);
            anyTranscriptChanged = true;
          }
        }
      } else {
        const hotIds = new Set();
        if (activeConvId && UUID_RE.test(activeConvId)) {
          hotIds.add(activeConvId);
        }
        const candidates = this.cachedIndexSummary
          ? this.cachedIndexSummary.sortedEntries
          : [...this.convCache.values()];
        let mainChecked = 0;
        for (const entry of candidates) {
          const entrySeenBaseline = Math.max(
            entry.lastSeenMs || 0,
            entry.lastViewMs || 0,
            entry.lastUserInputMs || 0
          );
          const isUnreadEntry = Boolean(
            !entry.isSubagent &&
            (entry.markedAsUnread ||
              (entry.lastModelResponse &&
                entry.lastModelResponseMs > 0 &&
                entry.lastModelResponseMs > entrySeenBaseline))
          );
          const isHot =
            mainChecked < 8 ||
            isUnreadEntry ||
            now - (entry.lastActiveMs || 0) < 15 * 60 * 1000 ||
            isEntryThinking(entry, now) ||
            Boolean(getEntryWaitState(entry, now)) ||
            entry.awaitingHandoffResponse ||
            entry.needsFullHandoffRead;
          if (isHot) {
            hotIds.add(entry.id);
            if (!entry.isSubagent) mainChecked += 1;
            if (entry.parentConvId) hotIds.add(entry.parentConvId);
            for (const subId of entry.spawnedSubagentIds || []) {
              hotIds.add(subId);
            }
          }
        }

        for (const convId of hotIds) {
          if (this.refreshEntryById(convId, activeConvId, activeWorkspaceNorm, false)) {
            anyTranscriptChanged = true;
          }
          const hotEntry = this.convCache.get(convId);
          for (const subId of (hotEntry && hotEntry.spawnedSubagentIds) || []) {
            if (!this.convCache.has(subId) && this.refreshEntryById(subId, activeConvId, activeWorkspaceNorm, false)) {
              anyTranscriptChanged = true;
            }
          }
        }

        const scanAllAnnotations =
          annotDirMtimeMs !== this.lastAnnotationsDirMtimeMs ||
          now - (this.lastAnnotationsScanMs || 0) >= 3000;
        if (scanAllAnnotations) {
          this.lastAnnotationsDirMtimeMs = annotDirMtimeMs;
          this.lastAnnotationsScanMs = now;
        }
        for (const [convId, entry] of this.convCache.entries()) {
          if (entry.isSubagent || hotIds.has(convId)) continue;
          const inActiveWs = Boolean(
            activeWsKey &&
            entry.workspacePath &&
            workspaceComparisonKey(entry.workspacePath) === activeWsKey
          );
          if (!scanAllAnnotations && !inActiveWs) continue;
          if (this.applyEntryMetadata(entry, convId, activeConvId, activeWorkspaceNorm, false)) {
            anyTranscriptChanged = true;
          }
        }
      }
    }

    if (!anyTranscriptChanged && this.cachedIndexSummary) {
      const endNs = process.hrtime.bigint();
      this.lastRefreshDurationMs = Number(endNs - startNs) / 1e6;
      return this.cachedIndexSummary;
    }

    const parentLookup = new Map();
    for (const entry of this.convCache.values()) {
      for (const childId of entry.spawnedSubagentIds || []) {
        parentLookup.set(childId, entry.id);
      }
    }

    const subagentTokens = new Map();
    for (const entry of this.convCache.values()) {
      if (parentLookup.has(entry.id)) {
        entry.isSubagent = true;
        entry.parentConvId = parentLookup.get(entry.id);
      }
      if (entry.isSubagent && entry.parentConvId) {
        const parentEntry = this.convCache.get(entry.parentConvId);
        if (parentEntry && !parentEntry.spawnedSubagentIds.includes(entry.id)) {
          parentEntry.spawnedSubagentIds.push(entry.id);
        }
        if (entry.totalTokens > 0) {
          subagentTokens.set(entry.parentConvId, (subagentTokens.get(entry.parentConvId) || 0) + entry.totalTokens);
        }
      }
    }

    const allRecentCompactTokens = [];
    const sortedEntries = [...this.convCache.values()].sort(
      (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0)
    );
    for (const entry of sortedEntries) {
      if (Array.isArray(entry.compactTriggerTokens) && entry.compactTriggerTokens.length > 0) {
        allRecentCompactTokens.push(...entry.compactTriggerTokens.slice(-5));
        if (allRecentCompactTokens.length >= 25) break;
      }
    }
    const globalObservedCeiling = computeMedian(allRecentCompactTokens);

    if (anyTranscriptChanged) {
      this.markTranscriptDirty({ resetSummary: false, saveIndex: true });
    }

    const summary = {
      sortedEntries,
      subagentTokens,
      globalObservedCeiling
    };
    this.cachedIndexSummary = summary;

    const endNs = process.hrtime.bigint();
    this.lastRefreshDurationMs = Number(endNs - startNs) / 1e6;

    return summary;
  }

  lookupModelLabel(modelEnum) {
    if (!modelEnum) return '';
    const found = this.cachedModelsCatalog.models.find((m) => m.modelEnum === modelEnum);
    return found ? found.label : '';
  }

  lookupModelByAny(val) {
    const clean = (typeof val === 'string' ? val : '').trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();
    return (
      this.cachedModelsCatalog.models.find(
        (m) =>
          m.modelEnum === clean ||
          m.modelId === clean ||
          m.label === clean ||
          (m.modelId && m.modelId.toLowerCase() === lower) ||
          m.label.toLowerCase() === lower
      ) || null
    );
  }

  getModelsCatalog(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.cachedModelsCatalog.models.length > 0 &&
      now - this.cachedModelsCatalog.fetchedAtMs < 60000
    ) {
      return Promise.resolve(this.cachedModelsCatalog);
    }
    if (this.modelsFetchPromise) {
      return this.modelsFetchPromise;
    }
    if (!force && now - this.cachedModelsCatalog.fetchedAtMs < 5000) {
      return Promise.resolve(this.cachedModelsCatalog);
    }
    this.modelsFetchPromise = (async () => {
      try {
        const res = await callLanguageServerRpc('GetCascadeModelConfigData', {});
        const parsed = parseCascadeModelConfigs(res);
        if (parsed.models.length > 0) {
          this.cachedModelQuotas = parsed.modelQuotas;
          const prevSig = JSON.stringify([
            this.cachedModelsCatalog.defaultModelEnum,
            this.cachedModelsCatalog.models.map((m) => m.modelEnum)
          ]);
          const nextSig = JSON.stringify([
            parsed.defaultModelEnum,
            parsed.models.map((m) => m.modelEnum)
          ]);
          this.cachedModelsCatalog = {
            models: parsed.models,
            defaultModelEnum: parsed.defaultModelEnum,
            fetchedAtMs: Date.now()
          };
          if (prevSig !== nextSig) {
            this.modelsCatalogRev += 1;
            this.cachedCardsState = null;
          }
        } else {
          this.cachedModelsCatalog.fetchedAtMs = Date.now();
        }
      } catch {} finally {
        this.modelsFetchPromise = null;
      }
      return this.cachedModelsCatalog;
    })();
    return this.modelsFetchPromise;
  }

  refreshQuotaSummary({ maxAgeMs = 60000, forceRemote = false } = {}) {
    if (this.quotaFetchPromise) return this.quotaFetchPromise;
    if (Date.now() - this.quotaFetchedAtMs < maxAgeMs) {
      return Promise.resolve(this.cachedQuota);
    }
    this.quotaFetchedAtMs = Date.now();
    this.quotaFetchPromise = (async () => {
      try {
        const res = await callLanguageServerRpc(
          'RetrieveUserQuotaSummary',
          forceRemote ? { forceRefresh: true } : {},
          8000
        );
        const summary = parseUserQuotaSummary(res);
        if (summary && summary.groups.length > 0) {
          this.applyQuota(summary);
        } else {
          if (this.cachedModelQuotas.length === 0) {
            await this.getModelsCatalog(false);
          }
          const fallback = buildQuotaFromModelConfigs(this.cachedModelQuotas);
          if (fallback.groups.length > 0) {
            this.applyQuota(fallback);
          } else if (summary) {
            this.applyQuota(null);
          }
        }
      } catch {} finally {
        this.quotaFetchedAtMs = Date.now();
        this.quotaFetchPromise = null;
      }
      return this.cachedQuota;
    })();
    return this.quotaFetchPromise;
  }

  applyQuota(quota) {
    const signature = JSON.stringify(quota ? [quota.source, quota.groups] : null);
    this.cachedQuota = quota ? { ...quota, fetchedAtMs: Date.now() } : null;
    if (signature !== this.lastQuotaSignature) {
      this.lastQuotaSignature = signature;
      this.stateVersion += 1;
    }
  }

  needsModelResolution(entry) {
    if (!entry || entry.isSubagent || !(entry.mtimeMs > 0)) return false;
    if (!entry.modelEnum) {
      if (entry.lastStepType === 'USER_INPUT' && !entry.lastPlannerTokens) return false;
      return entry.modelResolvedMtimeMs !== entry.mtimeMs;
    }
    return (
      entry.lastUserInputMs > 0 &&
      entry.modelResolvedMtimeMs < entry.lastUserInputMs &&
      entry.lastStepType !== 'USER_INPUT'
    );
  }

  async resolveConversationModelAsync(convId, force = false) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) return '';
    const entry = this.convCache.get(cleanId) || this.refreshSingleEntry(cleanId);
    if (!force && entry && !this.needsModelResolution(entry)) {
      return entry.modelEnum || '';
    }
    if (this.modelResolveInFlight.has(cleanId)) {
      return (entry && entry.modelEnum) || '';
    }
    const lastTry = this.modelResolveCooldown.get(cleanId) || 0;
    if (!force && Date.now() - lastTry < 4000) {
      return (entry && entry.modelEnum) || '';
    }
    this.modelResolveInFlight.add(cleanId);
    this.modelResolveCooldown.set(cleanId, Date.now());
    try {
      const res = await callLanguageServerRpc('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId: cleanId,
        generatorMetadataOffset: 0,
        includeMessages: false
      });
      const list = Array.isArray(res && res.generatorMetadata)
        ? res.generatorMetadata
        : (Array.isArray(res && res.data && res.data.generatorMetadata) ? res.data.generatorMetadata : []);
      let foundEnum = '';
      let foundLabel = '';
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (!item) continue;
        const mEnum =
          (item.plannerConfig &&
            item.plannerConfig.requestedModel &&
            (item.plannerConfig.requestedModel.model || item.plannerConfig.requestedModel.alias)) ||
          (item.plannerConfig && item.plannerConfig.planModel) ||
          (item.chatModel && item.chatModel.model) ||
          '';
        const mLabel =
          (item.chatModel && item.chatModel.modelDisplayName) ||
          (item.plannerConfig && item.plannerConfig.modelName) ||
          '';
        if ((mEnum && mEnum !== 'MODEL_UNSPECIFIED') || mLabel) {
          foundEnum = mEnum && mEnum !== 'MODEL_UNSPECIFIED' ? mEnum : '';
          foundLabel = mLabel;
          break;
        }
      }
      if (foundLabel || foundEnum) {
        const catalogHit =
          (foundEnum && this.lookupModelByAny(foundEnum)) ||
          (foundLabel && this.lookupModelByAny(foundLabel)) ||
          null;
        if (catalogHit) {
          foundEnum = catalogHit.modelEnum;
          foundLabel = catalogHit.label;
        }
      }
      const targetEntry = this.convCache.get(cleanId) || entry;
      if (targetEntry && (!res || !res.error || Number(res.statusCode) >= 400)) {
        const hasAnyModel = Boolean(foundEnum || targetEntry.modelEnum);
        const nextResolvedMtime = hasAnyModel
          ? Math.max(targetEntry.mtimeMs || 0, targetEntry.lastUserInputMs || 0, Date.now())
          : (targetEntry.mtimeMs || Date.now());
        const mtimeRecordedChanged = targetEntry.modelResolvedMtimeMs !== nextResolvedMtime;
        targetEntry.modelResolvedMtimeMs = nextResolvedMtime;
        if (foundEnum) {
          const resolvedLabel = foundLabel || this.lookupModelLabel(foundEnum) || '';
          if (
            targetEntry.modelEnum !== foundEnum ||
            (resolvedLabel && targetEntry.modelLabel !== resolvedLabel)
          ) {
            targetEntry.modelEnum = foundEnum;
            if (resolvedLabel) targetEntry.modelLabel = resolvedLabel;
            this.markTranscriptDirty({ resetSummary: false, saveIndex: true });
          } else if (mtimeRecordedChanged) {
            this.scheduleSaveIndexCache();
          }
        } else if (mtimeRecordedChanged) {
          this.scheduleSaveIndexCache();
        }
      }
      return foundEnum || (targetEntry && targetEntry.modelEnum) || '';
    } catch {
      return (entry && entry.modelEnum) || '';
    } finally {
      this.modelResolveInFlight.delete(cleanId);
    }
  }

  triggerBackgroundModelResolution(hostConvId, visibleEntries) {
    void this.syncTrajectoriesFromLanguageServer(false);
    void this.getModelsCatalog(false);
    void this.refreshQuotaSummary();
    const candidateIds = [];
    if (hostConvId && UUID_RE.test(hostConvId)) {
      const hostEntry = this.convCache.get(hostConvId);
      if (hostEntry && this.needsModelResolution(hostEntry)) {
        candidateIds.push(hostConvId);
      }
    }
    if (Array.isArray(visibleEntries)) {
      for (const e of visibleEntries) {
        if (!e || e.isSubagent) continue;
        if (!candidateIds.includes(e.id) && this.needsModelResolution(e)) {
          candidateIds.push(e.id);
        }
        if (candidateIds.length >= 4) break;
      }
    }
    for (const cid of candidateIds) {
      void this.resolveConversationModelAsync(cid, false);
    }
  }

  checkAgyBinaryChanged(force = false) {
    const now = Date.now();
    if (!force && now - this.lastBinaryStatCheckMs < 45000) {
      return;
    }
    this.lastBinaryStatCheckMs = now;
    const binPath = resolveLanguageServerBinary(this.appDataDir);
    if (!binPath) return;
    try {
      const stat = fs.statSync(binPath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) return;
      const sig = `${binPath}|${Math.floor(stat.mtimeMs)}|${stat.size}`;
      if (!this.diagnosticsState) {
        void this.runDiagnostics({ refresh: false });
      } else if (this.lastKnownBinarySig && sig !== this.lastKnownBinarySig) {
        void this.runDiagnostics({ refresh: true, agyUpdated: true });
      }
    } catch {}
  }

  readPluginInstallMeta(force = false) {
    if (!force && this.cachedInstallMeta) return this.cachedInstallMeta;
    const parentDir = path.resolve(__dirname, '..', '..');
    const defaultDir = path.join(path.dirname(this.projectsDir), 'plugins', 'agy-cockpit');
    const pluginDir = isFile(path.join(parentDir, 'plugin.json')) && !isDirectory(path.join(parentDir, '.git'))
      ? parentDir
      : defaultDir;
    const metaPath = path.join(pluginDir, 'install_meta.json');
    let installedCommit = '';
    let repoRoot = '';
    if (isFile(metaPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (typeof raw?.installedCommit === 'string' && /^[0-9a-f]{40}$/i.test(raw.installedCommit.trim())) {
          installedCommit = raw.installedCommit.trim().toLowerCase();
        }
        if (typeof raw?.repoRoot === 'string' && raw.repoRoot.trim()) {
          repoRoot = normalizeWorkspacePath(raw.repoRoot.trim());
        }
      } catch {}
    }
    if (!repoRoot && isDirectory(path.join(parentDir, '.git'))) {
      repoRoot = normalizeWorkspacePath(parentDir);
    }
    this.cachedInstallMeta = { pluginDir, metaPath, installedCommit, repoRoot };
    return this.cachedInstallMeta;
  }

  getPluginUpdatePayload() {
    const st = this.pluginUpdateState;
    const installedCommit = st.installedCommit || this.readPluginInstallMeta(false).installedCommit || '';
    const remoteCommit = st.remoteCommit || '';
    return {
      updateAvailable: Boolean(st.updateAvailable),
      installedCommit,
      installedShort: installedCommit.slice(0, 7),
      remoteCommit,
      remoteShort: remoteCommit.slice(0, 7),
      checkedAtMs: st.checkedAtMs || 0,
      localDirty: Boolean(st.localDirty),
      isAhead: Boolean(st.isAhead)
    };
  }

  async fetchRemoteMainCommit() {
    let apiErr = '';
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`, {
        headers: { 'User-Agent': 'agy-cockpit', Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const parsed = await res.json();
        if (typeof parsed?.sha === 'string' && /^[0-9a-f]{40}$/i.test(parsed.sha.trim())) {
          return { sha: parsed.sha.trim().toLowerCase(), error: '' };
        }
      } else {
        apiErr = `GitHub HTTP ${res.status}`;
      }
    } catch (err) {
      apiErr = err?.message || '';
    }
    const ls = await execFileAsync('git', ['ls-remote', `https://github.com/${GITHUB_REPO}.git`, `refs/heads/${GITHUB_BRANCH}`], {}, 6000);
    const m = ls.ok && /^([0-9a-f]{40})\b/i.exec((ls.stdout || '').trim());
    return m ? { sha: m[1].toLowerCase(), error: '' } : { sha: '', error: apiErr || ls.error || 'Could not reach GitHub' };
  }

  async checkPluginUpdate(force = false) {
    const now = Date.now();
    if (!force && this.pluginUpdateState.checkedAtMs > 0 && now - this.pluginUpdateState.checkedAtMs < PLUGIN_UPDATE_CHECK_INTERVAL_MS) {
      return this.pluginUpdateState;
    }
    if (this.pluginUpdateCheckPromise) return this.pluginUpdateCheckPromise;

    const runPromise = (async () => {
      let { installedCommit, repoRoot } = this.readPluginInstallMeta(true);
      const remoteRes = await this.fetchRemoteMainCommit();
      const remoteCommit = remoteRes.sha;
      if (!remoteCommit) {
        this.pluginUpdateState = {
          ...this.pluginUpdateState,
          installedCommit: installedCommit || this.pluginUpdateState.installedCommit || '',
          checkedAtMs: Date.now(),
          error: remoteRes.error || 'Could not reach GitHub'
        };
        return this.pluginUpdateState;
      }

      let localDirty = false;
      let isAhead = false;
      if (repoRoot && isDirectory(path.join(repoRoot, '.git'))) {
        if (!installedCommit) {
          const headRes = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }, 3000);
          const sha = (headRes.stdout || '').trim().toLowerCase();
          if (headRes.ok && /^[0-9a-f]{40}$/.test(sha)) installedCommit = sha;
        }
        const statusRes = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot }, 3000);
        localDirty = Boolean(statusRes.ok && statusRes.stdout.trim().length > 0);
        if (installedCommit && remoteCommit !== installedCommit) {
          const ancRes = await execFileAsync('git', ['merge-base', '--is-ancestor', remoteCommit, installedCommit], { cwd: repoRoot }, 3000);
          isAhead = Boolean(ancRes.ok);
        }
      }

      const updateAvailable = Boolean(!localDirty && (!installedCommit || (remoteCommit !== installedCommit && !isAhead)));
      const nextState = { updateAvailable, installedCommit: installedCommit || '', remoteCommit, checkedAtMs: Date.now(), localDirty, isAhead, error: '' };
      this.pluginUpdateState = nextState;

      const nextSig = `${nextState.updateAvailable}|${nextState.installedCommit}|${nextState.remoteCommit}|${nextState.localDirty}|${nextState.isAhead}`;
      if (nextSig !== this.lastPluginUpdateSig) {
        this.lastPluginUpdateSig = nextSig;
        this.pluginUpdateRev += 1;
        this.cachedCardsState = null;
      }
      return nextState;
    })();

    this.pluginUpdateCheckPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      this.pluginUpdateCheckPromise = null;
    }
  }

  async applyPluginUpdate() {
    if (this.pluginUpdateApplyPromise) return this.pluginUpdateApplyPromise;
    const failUpdate = (status, error) => ({ status, body: { ok: false, updated: false, error, pluginUpdate: this.getPluginUpdatePayload() } });

    const runPromise = (async () => {
      const st = await this.checkPluginUpdate(true);
      if (st.error || !st.remoteCommit) return failUpdate(502, st.error || 'Could not reach GitHub to check for updates');
      if (!st.updateAvailable) {
        const blockedByDirty = Boolean(st.localDirty && st.remoteCommit && (!st.installedCommit || (st.remoteCommit !== st.installedCommit && !st.isAhead)));
        const pluginUpdate = this.getPluginUpdatePayload();
        return { status: 200, body: { ok: true, updated: false, upToDate: !blockedByDirty, blockedByDirty, ...pluginUpdate, pluginUpdate } };
      }

      const { pluginDir, metaPath, repoRoot } = this.readPluginInstallMeta(false);
      const sidecarDir = path.join(pluginDir, 'sidecars', 'agy-cockpit');
      const targetCommit = st.remoteCommit;
      const relFiles = ['plugin.json', 'README.md', 'sidecars/agy-cockpit/sidecar.json', 'sidecars/agy-cockpit/server.cjs', 'sidecars/agy-cockpit/ui.html'];
      const fileBuffers = new Map();

      if (repoRoot && isDirectory(path.join(repoRoot, '.git'))) {
        const pullRes = await execFileAsync('git', ['pull', '--ff-only'], { cwd: repoRoot }, 12000);
        const headRes = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }, 3000);
        if (!pullRes.ok || !headRes.ok || headRes.stdout.trim().toLowerCase() !== targetCommit) {
          return failUpdate(502, `Local git pull --ff-only did not reach ${targetCommit.slice(0, 7)}: ${(pullRes.stderr || pullRes.error || 'branch diverged').trim()}`);
        }
        try {
          for (const rel of relFiles) {
            fileBuffers.set(rel, fs.readFileSync(path.join(repoRoot, ...rel.split('/'))));
          }
        } catch (err) {
          return failUpdate(500, `Failed to read updated files from local repo: ${err.message}`);
        }
      } else {
        try {
          await Promise.all(relFiles.map(async (rel) => {
            const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${targetCommit}/${rel}`, {
              headers: { 'User-Agent': 'agy-cockpit' },
              signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) throw new Error(`${rel} (HTTP ${res.status})`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0) throw new Error(`${rel} (empty response)`);
            fileBuffers.set(rel, buf);
          }));
        } catch (err) {
          return failUpdate(502, `Failed to download update from GitHub: ${err.message}`);
        }
      }

      let parsedSidecarManifest;
      try {
        const parsedPlugin = JSON.parse(fileBuffers.get('plugin.json').toString('utf-8'));
        parsedSidecarManifest = JSON.parse(fileBuffers.get('sidecars/agy-cockpit/sidecar.json').toString('utf-8'));
        if (!parsedPlugin || typeof parsedPlugin !== 'object' || !parsedSidecarManifest || typeof parsedSidecarManifest !== 'object') {
          throw new Error('Malformed manifest JSON');
        }
      } catch (err) {
        return failUpdate(502, `Invalid manifest in downloaded update: ${err.message}`);
      }

      const serverBuf = fileBuffers.get('sidecars/agy-cockpit/server.cjs');
      const uiBuf = fileBuffers.get('sidecars/agy-cockpit/ui.html');
      if (!serverBuf || serverBuf.length < 1000 || !uiBuf || uiBuf.length < 1000) {
        return failUpdate(502, 'Downloaded sidecar files are unexpectedly truncated');
      }

      parsedSidecarManifest.command = process.execPath.replace(/\\/g, '/');
      try {
        writeFileAtomic(path.join(pluginDir, 'plugin.json'), fileBuffers.get('plugin.json'));
        writeFileAtomic(path.join(pluginDir, 'README.md'), fileBuffers.get('README.md'));
        writeJsonAtomic(path.join(sidecarDir, 'sidecar.json'), parsedSidecarManifest, undefined, true);
        writeFileAtomic(path.join(sidecarDir, 'server.cjs'), serverBuf);
        writeFileAtomic(path.join(sidecarDir, 'ui.html'), uiBuf);
        writeJsonAtomic(metaPath, { installedCommit: targetCommit, repoRoot, installedAtMs: Date.now() }, undefined, true);
      } catch (writeErr) {
        return failUpdate(500, `Failed to write updated plugin files: ${writeErr.message}`);
      }

      this.cachedInstallMeta = { pluginDir, metaPath, installedCommit: targetCommit, repoRoot };
      this.pluginUpdateState = { updateAvailable: false, installedCommit: targetCommit, remoteCommit: targetCommit, checkedAtMs: Date.now(), localDirty: false, isAhead: false, error: '' };
      this.lastPluginUpdateSig = `false|${targetCommit}|${targetCommit}|false|false`;
      this.pluginUpdateRev += 1;
      this.cachedCardsState = null;

      const pluginUpdate = this.getPluginUpdatePayload();
      return { status: 200, body: { ok: true, updated: true, ...pluginUpdate, pluginUpdate } };
    })();

    this.pluginUpdateApplyPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      this.pluginUpdateApplyPromise = null;
    }
  }

  getDiagnosticsStatusPayload(query = {}) {
    const sim = typeof query.simulateDiag === 'string' ? query.simulateDiag.trim().toLowerCase() : '';
    if (sim === 'fail' || sim === 'warn') {
      const isFail = sim === 'fail';
      const simIssue = {
        id: 'language_server_binary',
        title: 'Language Server Binary & RPC Symbols',
        status: isFail ? 'fail' : 'warn',
        codeSymbol: 'server.cjs:callLanguageServerRpc',
        detail: isFail
          ? 'Simulated failure: RPC GetCascadeModelConfigData not found in language_server binary.'
          : 'Simulated warning: RPC DeleteCascadeTrajectory not found in language_server binary (using disk fallback).',
        fixHint: 'Update RPC method name in sidecars/agy-cockpit/server.cjs (callLanguageServerRpc callers).'
      };
      return {
        status: isFail ? 'fail' : 'warn',
        issueCount: 1,
        failCount: isFail ? 1 : 0,
        warnCount: isFail ? 0 : 1,
        signature: `sim:${sim}`,
        checkedAtMs: Date.now(),
        agyUpdated: true,
        issues: [simIssue]
      };
    }

    const st = this.diagnosticsState;
    if (!st) {
      return {
        status: 'ok',
        issueCount: 0,
        failCount: 0,
        warnCount: 0,
        signature: 'ok',
        checkedAtMs: 0,
        agyUpdated: false,
        issues: []
      };
    }
    const issues = Array.isArray(st.contracts)
      ? st.contracts.filter((c) => c.status !== 'pass')
      : [];
    return {
      status: st.status || 'ok',
      issueCount: issues.length,
      failCount: st.failCount || 0,
      warnCount: st.warnCount || 0,
      signature: st.signature || 'ok',
      checkedAtMs: st.checkedAtMs || 0,
      agyUpdated: Boolean(st.agyUpdated),
      issues
    };
  }

  async runDiagnostics(options = {}) {
    const refresh = Boolean(options.refresh);
    const offlineMode = Boolean(options.offlineMode);
    const simulate = typeof options.simulate === 'string' ? options.simulate.trim().toLowerCase() : '';

    if (
      !refresh &&
      !simulate &&
      this.diagnosticsState &&
      Date.now() - (this.diagnosticsState.checkedAtMs || 0) < 30000
    ) {
      return this.diagnosticsState;
    }
    if (this.diagnosticsPromise && !simulate) {
      return this.diagnosticsPromise;
    }

    const runPromise = (async () => {
      const startNs = process.hrtime.bigint();
      const contracts = [];
      const addContract = (id, title, status, codeSymbol, detail, fixHint = '') => {
        contracts.push({ id, title, status, codeSymbol, detail, fixHint });
      };

      const appDirExists = isDirectory(this.appDataDir);
      const brainDirExists = isDirectory(this.brainDir);
      const projectsDirExists = isDirectory(this.projectsDir);
      if (!appDirExists) {
        addContract(
          'app_data_dirs',
          'On-Disk App Data & Directories',
          'fail',
          'server.cjs:resolveAppDataDir',
          `App data directory not found at ${this.appDataDir}`,
          'Check APP_CANDIDATES or ANTIGRAVITY_APP_DATA_DIR resolution in server.cjs:resolveAppDataDir().'
        );
      } else {
        addContract(
          'app_data_dirs',
          'On-Disk App Data & Directories',
          'pass',
          'server.cjs:resolveAppDataDir, resolveProjectsDir',
          `appDataDir=${this.appDataDir} (brain=${brainDirExists ? 'ok' : 'empty'}, projects=${projectsDirExists ? 'ok' : 'empty'})`
        );
      }

      let convDirsChecked = 0;
      let transcriptsFound = 0;
      let userStepsCount = 0;
      let plannerStepsCount = 0;
      let plannerWithTokensCount = 0;
      let toolCallsCount = 0;
      let validToolCallsCount = 0;
      let genericStepsCount = 0;
      let truncatedStepsCount = 0;
      let truncatedMarkerMatchedCount = 0;
      let truncatedWithoutFullCount = 0;
      let breakdownProbeOk = true;
      let breakdownProbeError = '';

      if (brainDirExists) {
        try {
          const dirents = fs.readdirSync(this.brainDir, { withFileTypes: true });
          const uuidDirs = [];
          for (const d of dirents) {
            if (!d.isDirectory() || !UUID_RE.test(d.name)) continue;
            const sysGenDir = path.join(this.brainDir, d.name, '.system_generated');
            const trPath = path.join(sysGenDir, 'logs', 'transcript.jsonl');
            let mtimeMs = 0;
            try {
              const st = fs.statSync(trPath, { throwIfNoEntry: false }) || fs.statSync(sysGenDir, { throwIfNoEntry: false });
              mtimeMs = st ? st.mtimeMs : 0;
            } catch {}
            if (mtimeMs > 0) {
              uuidDirs.push({ id: d.name, trPath, mtimeMs });
            }
          }
          uuidDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
          for (const item of uuidDirs.slice(0, 12)) {
            convDirsChecked += 1;
            if (!isFile(item.trPath)) continue;
            transcriptsFound += 1;
            if (transcriptsFound === 1) {
              try {
                const bd = buildContextBreakdownForTranscript(
                  item.id.toLowerCase(),
                  item.trPath,
                  this.convCache.get(item.id.toLowerCase()) || null,
                  0
                );
                if (
                  !bd ||
                  !Array.isArray(bd.categories) ||
                  bd.categories.length !== 4 ||
                  !Array.isArray(bd.heaviestSteps) ||
                  !Array.isArray(bd.activeSkills)
                ) {
                  breakdownProbeOk = false;
                  breakdownProbeError = 'buildContextBreakdownForTranscript returned malformed payload';
                }
              } catch (bdErr) {
                breakdownProbeOk = false;
                breakdownProbeError = bdErr && bdErr.message ? bdErr.message : String(bdErr);
              }
            }
            const lines = readFileTailLines(item.trPath, 512 * 1024, 80);
            for (const line of lines) {
              let obj;
              try {
                obj = JSON.parse(line);
              } catch {
                continue;
              }
              if (obj.type === 'USER_INPUT') userStepsCount += 1;
              if (obj.type === 'GENERIC' && typeof obj.content === 'string' && obj.content.length > 0) {
                genericStepsCount += 1;
              }
              if (obj.type === 'PLANNER_RESPONSE') {
                plannerStepsCount += 1;
                if (
                  typeof obj.input_tokens === 'number' ||
                  typeof obj.cache_read_tokens === 'number' ||
                  typeof obj.output_tokens === 'number'
                ) {
                  plannerWithTokensCount += 1;
                }
                if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
                  for (const tc of obj.tool_calls) {
                    toolCallsCount += 1;
                    if (tc && typeof tc.name === 'string' && tc.args && typeof tc.args === 'object') {
                      validToolCallsCount += 1;
                    }
                  }
                }
              }
              if (Array.isArray(obj.truncated_fields) && obj.truncated_fields.length > 0) {
                truncatedStepsCount += 1;
                if (/<truncated\s+\d+\s+bytes>/i.test(line)) {
                  truncatedMarkerMatchedCount += 1;
                }
                const fullPath = path.join(path.dirname(item.trPath), 'transcript_full.jsonl');
                if (!isFile(fullPath)) {
                  truncatedWithoutFullCount += 1;
                }
              }
            }
          }
        } catch {}
      }

      if (convDirsChecked >= 3 && transcriptsFound === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'fail',
          'server.cjs:processTranscriptLine, updateTranscriptEntry, buildContextBreakdownForTranscript',
          `Found ${convDirsChecked} conversation directories with .system_generated, but 0 logs/transcript.jsonl files.`,
          'Antigravity may have moved or renamed .system_generated/logs/transcript.jsonl. Update transcript path resolution in server.cjs.'
        );
      } else if (transcriptsFound > 0 && userStepsCount === 0 && plannerStepsCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'fail',
          'server.cjs:processTranscriptLine, buildContextBreakdownForTranscript',
          `Sampled ${transcriptsFound} transcript.jsonl files, but found 0 USER_INPUT or PLANNER_RESPONSE steps.`,
          'Step type enum names in transcript.jsonl may have changed. Check processTranscriptLine() and buildContextBreakdownForTranscript() in server.cjs.'
        );
      } else if (plannerStepsCount >= 3 && plannerWithTokensCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:processTranscriptLine, buildContextBreakdownForTranscript',
          `Found ${plannerStepsCount} PLANNER_RESPONSE steps across ${transcriptsFound} transcripts, but none had input_tokens/cache_read_tokens/output_tokens.`,
          'Token usage field names in transcript.jsonl may have changed. Update token extraction in server.cjs:processTranscriptLine() and buildContextBreakdownForTranscript().'
        );
      } else if (toolCallsCount >= 3 && validToolCallsCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:classifyToolCallsWait, extractPathsFromToolCalls, processTranscriptLine, buildContextBreakdownForTranscript',
          `Found ${toolCallsCount} tool_calls entries across ${transcriptsFound} transcripts, but none matched { name, args }.`,
          'Tool call schema in PLANNER_RESPONSE changed. Update classifyToolCallsWait(), processTranscriptLine(), and buildContextBreakdownForTranscript() in server.cjs.'
        );
      } else if (toolCallsCount >= 5 && genericStepsCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:buildContextBreakdownForTranscript, processTranscriptLine',
          `Found ${toolCallsCount} tool_calls across ${transcriptsFound} transcripts, but 0 GENERIC tool output steps.`,
          'Tool output step type in transcript.jsonl may have changed from GENERIC. Update buildContextBreakdownForTranscript() and processTranscriptLine() in server.cjs.'
        );
      } else if (truncatedStepsCount >= 3 && truncatedMarkerMatchedCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:estimateRawUtf8Bytes, buildContextBreakdownForTranscript, processTranscriptLine',
          `Found ${truncatedStepsCount} steps with truncated_fields, but 0 matched the '<truncated N bytes>' marker format.`,
          'Antigravity changed the truncation marker format in transcript.jsonl. Update TRUNCATED_BYTES_RE and estimateRawUtf8Bytes() in server.cjs.'
        );
      } else if (!breakdownProbeOk) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:buildContextBreakdownForTranscript, handleContextBreakdown',
          `Context breakdown probe failed: ${breakdownProbeError}`,
          'Inspect buildContextBreakdownForTranscript() in server.cjs.'
        );
      } else if (truncatedWithoutFullCount > 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:resolveFullCheckpointOverview',
          `Found ${truncatedWithoutFullCount} steps with truncated_fields where transcript_full.jsonl was missing.`,
          'Check whether transcript_full.jsonl was renamed in .system_generated/logs/.'
        );
      } else {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'pass',
          'server.cjs:processTranscriptLine, classifyToolCallsWait, buildContextBreakdownForTranscript',
          `Verified ${transcriptsFound} recent transcript(s) (${userStepsCount} USER_INPUT, ${plannerWithTokensCount}/${plannerStepsCount} PLANNER_RESPONSE with tokens, ${validToolCallsCount}/${toolCallsCount} tool_calls, ${genericStepsCount} GENERIC outputs, ${truncatedMarkerMatchedCount}/${truncatedStepsCount} truncated markers, breakdown=ok).`
        );
      }

      let pbtxtChecked = 0;
      let pbtxtParsedFields = 0;
      if (isDirectory(this.annotationsDir)) {
        try {
          const files = fs.readdirSync(this.annotationsDir).filter((f) => f.endsWith('.pbtxt')).slice(0, 15);
          for (const f of files) {
            const fp = path.join(this.annotationsDir, f);
            const st = fs.statSync(fp, { throwIfNoEntry: false });
            if (!st || st.size < 8) continue;
            pbtxtChecked += 1;
            const raw = fs.readFileSync(fp, 'utf-8');
            const parsed = extractAnnotationFromPbtxt(raw);
            if (parsed.lastViewMs > 0 || parsed.title || parsed.archived || parsed.markedAsUnread) {
              pbtxtParsedFields += 1;
            }
          }
        } catch {}
      }
      if (pbtxtChecked >= 3 && pbtxtParsedFields === 0) {
        addContract(
          'annotations_pbtxt',
          'Conversation Annotations (.pbtxt) Schema',
          'warn',
          'server.cjs:extractAnnotationFromPbtxt, resolveConversationAnnotation',
          `Checked ${pbtxtChecked} non-empty .pbtxt files in annotations/, but 0 matched title/last_user_view_time/archived.`,
          'Inspect ~/.gemini/antigravity/annotations/*.pbtxt and update regexes in server.cjs:extractAnnotationFromPbtxt().'
        );
      } else {
        addContract(
          'annotations_pbtxt',
          'Conversation Annotations (.pbtxt) Schema',
          'pass',
          'server.cjs:extractAnnotationFromPbtxt, resolveConversationAnnotation',
          pbtxtChecked > 0
            ? `Parsed ${pbtxtParsedFields}/${pbtxtChecked} sampled annotation .pbtxt file(s).`
            : 'No annotation .pbtxt files present yet.'
        );
      }

      let projFilesChecked = 0;
      let projWithRawResources = 0;
      let projWithExtractedPaths = 0;
      if (projectsDirExists) {
        try {
          const files = fs.readdirSync(this.projectsDir).filter((f) => f.toLowerCase().endsWith('.json')).slice(0, 20);
          for (const f of files) {
            const projId = f.slice(0, -5);
            if (!UUID_RE.test(projId)) continue;
            const fp = path.join(this.projectsDir, f);
            const rawObj = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            projFilesChecked += 1;
            const hasRawRes =
              (Array.isArray(rawObj?.projectResources?.resources) && rawObj.projectResources.resources.length > 0) ||
              (Array.isArray(rawObj?.environments?.environments) && rawObj.environments.environments.length > 0);
            if (hasRawRes) {
              projWithRawResources += 1;
              const extracted = extractProjectResourcePaths(rawObj);
              if (extracted.length > 0) {
                projWithExtractedPaths += 1;
              }
            }
          }
        } catch {}
      }
      if (projWithRawResources > 0 && projWithExtractedPaths === 0) {
        addContract(
          'projects_registry',
          'Projects Registry JSON Schema',
          'warn',
          'server.cjs:extractProjectResourcePaths, refreshProjectsRegistry',
          `Found ${projWithRawResources} project JSON file(s) with resources, but extractProjectResourcePaths() extracted 0 folder URIs.`,
          'Inspect ~/.gemini/config/projects/*.json and update folderUri extraction in server.cjs:extractProjectResourcePaths().'
        );
      } else {
        addContract(
          'projects_registry',
          'Projects Registry JSON Schema',
          'pass',
          'server.cjs:extractProjectResourcePaths, refreshProjectsRegistry',
          `Verified ${projFilesChecked} project JSON file(s) (${projWithExtractedPaths}/${projWithRawResources} resource path sets extracted).`
        );
      }

      const lsBinPath = resolveLanguageServerBinary(this.appDataDir);
      const rpcMethodNames = LSRPC_CONTRACT_SPECS.map((s) => s.method);
      const subagentSymbols = ['Created the following subagent', 'invoke_subagent'];
      const allSymbolsToScan = [
        'LanguageServerService',
        ...rpcMethodNames,
        ...subagentSymbols,
        'send-message',
        'new-conversation'
      ];
      const symbolsKey = allSymbolsToScan.join(',');
      const binScan = scanBinarySymbols(lsBinPath, allSymbolsToScan);
      const nextBinarySig = lsBinPath && binScan.mtimeMs > 0
        ? `${lsBinPath}|${binScan.mtimeMs}|${binScan.size}`
        : '';
      const agyUpdated = Boolean(
        options.agyUpdated ||
        (this.lastKnownBinarySig && nextBinarySig && this.lastKnownBinarySig !== nextBinarySig)
      );
      if (
        nextBinarySig &&
        !binScan.error &&
        (nextBinarySig !== this.lastKnownBinarySig || symbolsKey !== this.lastKnownSymbolsKey)
      ) {
        this.lastKnownBinarySig = nextBinarySig;
        this.lastKnownSymbolsKey = symbolsKey;
        try {
          writeJsonAtomic(this.diagnosticsCachePath, {
            binarySig: nextBinarySig,
            symbolsKey,
            foundSymbols: [...binScan.found],
            updatedAtMs: Date.now()
          });
        } catch {}
      }

      if (!lsBinPath || binScan.error) {
        addContract(
          'language_server_binary',
          'Language Server Binary & RPC Symbols',
          'warn',
          'server.cjs:resolveLanguageServerBinary, callLanguageServerRpc',
          `Could not locate or scan language_server binary (${binScan.error || 'not found'}).`,
          'Update binary candidate paths in server.cjs:resolveLanguageServerBinary().'
        );
      } else {
        const missingCritical = LSRPC_CONTRACT_SPECS
          .filter((s) => s.critical && !binScan.found.has(s.method));
        const missingOptional = [
          ...LSRPC_CONTRACT_SPECS.filter((s) => !s.critical && !binScan.found.has(s.method)),
          ...subagentSymbols
            .filter((sym) => !binScan.found.has(sym))
            .map((sym) => ({ method: sym, caller: 'processTranscriptLine (subagents)' }))
        ];
        const hasService = binScan.found.has('LanguageServerService');

        if (!hasService || missingCritical.length > 0) {
          const missingNames = [
            ...(!hasService ? ['LanguageServerService'] : []),
            ...missingCritical.map((m) => `${m.method} (${m.caller})`),
            ...missingOptional.map((m) => `${m.method} (${m.caller})`)
          ];
          addContract(
            'language_server_binary',
            'Language Server Binary & RPC Symbols',
            'fail',
            'server.cjs:callLanguageServerRpc',
            `Missing critical RPC symbol(s) in language_server binary: ${missingNames.join('; ')}`,
            'Antigravity renamed or removed LanguageServerService RPC method(s). Run /agy-api-audit and update callLanguageServerRpc callers in server.cjs.'
          );
        } else if (missingOptional.length > 0) {
          addContract(
            'language_server_binary',
            'Language Server Binary & RPC Symbols',
            'warn',
            'server.cjs:callLanguageServerRpc, processTranscriptLine',
            `Missing optional symbol(s) in language_server binary: ${missingOptional.map((m) => `${m.method} [${m.caller}]`).join('; ')}`,
            'Update renamed RPC method(s) or subagent markers in server.cjs.'
          );
        } else {
          addContract(
            'language_server_binary',
            'Language Server Binary & RPC Symbols',
            'pass',
            'server.cjs:callLanguageServerRpc, processTranscriptLine',
            `All ${rpcMethodNames.length} RPC methods + subagent symbols + LanguageServerService verified in ${path.basename(lsBinPath)}.`
          );
        }
      }

      const hasLsEnv = Boolean(
        (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() &&
        (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim()
      );
      if (!hasLsEnv) {
        if (offlineMode) {
          addContract(
            'language_server_live_rpc',
            'Live Language Server RPC Probe',
            'pass',
            'server.cjs:callLanguageServerRpc, parseCascadeModelConfigs',
            'Offline CLI mode (sidecar process not attached to live Language Server env; binary symbols verified).'
          );
        } else {
          addContract(
            'language_server_live_rpc',
            'Live Language Server RPC Probe',
            'warn',
            'server.cjs:callLanguageServerRpc',
            'Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN in running sidecar environment.',
            'Check if Antigravity renamed sidecar Language Server environment variables.'
          );
        }
      } else {
        const modelRpcRes = await callLanguageServerRpc('GetCascadeModelConfigData', {}, 4000);
        if (modelRpcRes && modelRpcRes.error) {
          addContract(
            'language_server_live_rpc',
            'Live Language Server RPC Probe',
            'fail',
            'server.cjs:getModelsCatalog, callLanguageServerRpc',
            `Live GetCascadeModelConfigData RPC failed: ${modelRpcRes.error}`,
            'Inspect LanguageServerService/GetCascadeModelConfigData request/response contract in server.cjs:getModelsCatalog().'
          );
        } else {
          const parsedCatalog = parseCascadeModelConfigs(modelRpcRes);
          if (parsedCatalog.models.length === 0) {
            addContract(
              'language_server_live_rpc',
              'Live Language Server RPC Probe',
              'warn',
              'server.cjs:parseCascadeModelConfigs',
              'GetCascadeModelConfigData returned HTTP 200, but parseCascadeModelConfigs() extracted 0 models.',
              'The clientModelConfigs / modelOrAlias response schema in GetCascadeModelConfigData changed. Update server.cjs:parseCascadeModelConfigs().'
            );
          } else {
            let metaDetail = `GetCascadeModelConfigData returned ${parsedCatalog.models.length} models (default=${parsedCatalog.defaultModelEnum || 'auto'})`;
            const quotaRes = await callLanguageServerRpc('RetrieveUserQuotaSummary', {}, 6000);
            const parsedQuota = parseUserQuotaSummary(quotaRes);
            if (!parsedQuota) {
              metaDetail += `; RetrieveUserQuotaSummary unavailable (${String((quotaRes && quotaRes.error) || 'empty').slice(0, 160)}), quota ring falls back to ${parsedCatalog.modelQuotas.length} clientModelConfigs[].quotaInfo entries`;
            } else if (parsedQuota.groups.length === 0) {
              const quotaRoot = quotaRes.response && typeof quotaRes.response === 'object' ? quotaRes.response : quotaRes;
              metaDetail += `; RetrieveUserQuotaSummary returned no usable buckets (keys: ${Object.keys(quotaRoot).join(',') || 'none'}), fallback quotaInfo entries: ${parsedCatalog.modelQuotas.length}`;
            } else {
              metaDetail += `; RetrieveUserQuotaSummary: ${summarizeQuotaForDiagnostics(parsedQuota)}`;
            }
            const sampleEntry = [...this.convCache.values()].find((e) => !e.isSubagent && UUID_RE.test(e.id));
            if (sampleEntry) {
              const metaRes = await callLanguageServerRpc(
                'GetCascadeTrajectoryGeneratorMetadata',
                { cascadeId: sampleEntry.id, generatorMetadataOffset: 0, includeMessages: false },
                3500
              );
              if (metaRes && metaRes.error && Number(metaRes.statusCode) === 404) {
                addContract(
                  'language_server_live_rpc',
                  'Live Language Server RPC Probe',
                  'warn',
                  'server.cjs:resolveConversationModelAsync',
                  `GetCascadeTrajectoryGeneratorMetadata returned HTTP 404 (${metaRes.error}).`,
                  'Update trajectory model metadata RPC in server.cjs:resolveConversationModelAsync().'
                );
              } else {
                metaDetail += '; GetCascadeTrajectoryGeneratorMetadata HTTP 200.';
                addContract(
                  'language_server_live_rpc',
                  'Live Language Server RPC Probe',
                  'pass',
                  'server.cjs:getModelsCatalog, resolveConversationModelAsync',
                  metaDetail
                );
              }
            } else {
              addContract(
                'language_server_live_rpc',
                'Live Language Server RPC Probe',
                'pass',
                'server.cjs:getModelsCatalog, parseCascadeModelConfigs',
                metaDetail
              );
            }
          }
        }
      }

      const agentApiCmd = resolveAgentApiCommand(this.appDataDir);
      const agentApiFileExists = Boolean(agentApiCmd && agentApiCmd.file && isFile(agentApiCmd.file));
      const hasSendMsgSym = !lsBinPath || binScan.error || binScan.found.has('send-message');
      const hasNewConvSym = !lsBinPath || binScan.error || binScan.found.has('new-conversation');
      if (!agentApiFileExists) {
        addContract(
          'agentapi_cli',
          'AgentAPI CLI Binary & Subcommands',
          'fail',
          'server.cjs:resolveAgentApiCommand, execAgentApi',
          `AgentAPI executable not found on disk (resolved: ${agentApiCmd ? agentApiCmd.file : 'none'}).`,
          'Update binary resolution in server.cjs:resolveAgentApiCommand().'
        );
      } else if (!hasSendMsgSym || !hasNewConvSym) {
        const missingCmds = [
          ...(!hasSendMsgSym ? ['send-message'] : []),
          ...(!hasNewConvSym ? ['new-conversation'] : [])
        ];
        addContract(
          'agentapi_cli',
          'AgentAPI CLI Binary & Subcommands',
          'fail',
          'server.cjs:execAgentApi',
          `AgentAPI binary (${path.basename(agentApiCmd.file)}) is missing subcommand symbol(s): ${missingCmds.join(', ')}`,
          'Check new CLI subcommands in language_server agentapi and update server.cjs:execAgentApi() callers.'
        );
      } else {
        addContract(
          'agentapi_cli',
          'AgentAPI CLI Binary & Subcommands',
          'pass',
          'server.cjs:resolveAgentApiCommand, execAgentApi',
          `Resolved ${agentApiCmd.file} with send-message and new-conversation subcommands.`
        );
      }

      const preloadContent = this.loadPreloadJs();
      const requiredBridgeTokens = [
        'window.sidecar',
        'sendMessage',
        'startConversation',
        'toggleConversation',
        'toggleAuxPane',
        'getWorkspaceUris',
        'onWorkspaceChange'
      ];
      const missingBridge = requiredBridgeTokens.filter((t) => !preloadContent.includes(t));
      const warmRefreshMs = Number((this.lastRefreshDurationMs || 0).toFixed(2));
      if (missingBridge.length > 0) {
        addContract(
          'sidecar_bridge_and_perf',
          'Sidecar Preload Bridge & Performance Budget',
          'fail',
          'server.cjs:loadPreloadJs, FALLBACK_PRELOAD_JS',
          `/preload.js is missing required window.sidecar method(s): ${missingBridge.join(', ')}`,
          'Update FALLBACK_PRELOAD_JS or loadPreloadJs() in server.cjs.'
        );
      } else if (warmRefreshMs > 25 && this.initialBootScanDone) {
        addContract(
          'sidecar_bridge_and_perf',
          'Sidecar Preload Bridge & Performance Budget',
          'warn',
          'server.cjs:refreshIndex, handleStatusRequest',
          `Bridge OK (built-in preload.js), but last /api/status refresh took ${warmRefreshMs} ms (target < 5 ms warm).`,
          'Check incremental parsing and mtimeMs caches in server.cjs:refreshIndex().'
        );
      } else {
        addContract(
          'sidecar_bridge_and_perf',
          'Sidecar Preload Bridge & Performance Budget',
          'pass',
          'server.cjs:loadPreloadJs, handleStatusRequest',
          `Bridge OK (built-in preload.js), warm /api/status refresh=${warmRefreshMs} ms.`
        );
      }

      if (simulate === 'fail' || simulate === 'warn') {
        contracts.push({
          id: 'simulated_contract',
          title: 'Simulated AGY Breaking Change',
          status: simulate === 'fail' ? 'fail' : 'warn',
          codeSymbol: 'server.cjs:callLanguageServerRpc',
          detail: simulate === 'fail'
            ? 'Simulated FAIL: LanguageServerService RPC signature changed after AGY update.'
            : 'Simulated WARN: Optional RPC method changed; fallback active.',
          fixHint: 'Run node setup.cjs --doctor and update the affected contract in server.cjs.'
        });
      }

      const failCount = contracts.filter((c) => c.status === 'fail').length;
      const warnCount = contracts.filter((c) => c.status === 'warn').length;
      const issueCount = failCount + warnCount;
      const overallStatus = failCount > 0 ? 'fail' : (warnCount > 0 ? 'warn' : 'ok');
      const issuesSig = issueCount === 0
        ? 'ok'
        : contracts
            .filter((c) => c.status !== 'pass')
            .map((c) => `${c.id}:${c.status}:${c.detail}`)
            .join('|');
      const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
      const nowMs = Date.now();

      const report = {
        status: overallStatus,
        checkedAtMs: nowMs,
        checkedAtIso: new Date(nowMs).toISOString(),
        durationMs,
        agyUpdated,
        agyBinary: {
          path: lsBinPath || '',
          mtimeMs: binScan.mtimeMs || 0,
          size: binScan.size || 0
        },
        issueCount,
        failCount,
        warnCount,
        signature: issuesSig,
        contracts
      };

      if (!simulate) {
        const prevSig = this.diagnosticsState ? this.diagnosticsState.signature : '';
        this.diagnosticsState = report;
        if (prevSig !== issuesSig) {
          this.diagnosticsRev += 1;
          this.cachedCardsState = null;
        }
      }
      return report;
    })();

    if (!simulate) {
      this.diagnosticsPromise = runPromise;
      try {
        return await runPromise;
      } finally {
        this.diagnosticsPromise = null;
      }
    }
    return runPromise;
  }

  resolveSubagentsState(entry, nowMs = Date.now()) {
    let waitState = getEntryWaitState(entry, nowMs);
    let waitToolName = waitState ? (entry.lastStepWaitToolName || '') : '';
    let isThinking = !waitState && isEntryThinking(entry, nowMs);
    const subagents = [];
    const seen = new Set();
    for (const rawId of entry.spawnedSubagentIds || []) {
      const childId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
      if (!childId || seen.has(childId)) continue;
      seen.add(childId);
      const child = this.convCache.get(childId);
      if (!child) continue;
      const cw = getEntryWaitState(child, nowMs);
      const cwTool = cw ? (child.lastStepWaitToolName || '') : '';
      const ct = !cw && isEntryThinking(child, nowMs);
      const fallback = (child.firstPrompt || child.lastPrompt || '').split('\n')[0].trim().slice(0, 80);
      const title =
        this.customTitles.get(child.id) ||
        (entry.subagentRoles && entry.subagentRoles[child.id]) ||
        child.title ||
        fallback ||
        ('Subagent ' + child.id.slice(0, 8));
      subagents.push({
        id: child.id,
        title,
        totalTokens: child.totalTokens || 0,
        isThinking: ct,
        waitState: cw,
        waitToolName: cwTool
      });
      if (cw && !waitState) {
        waitState = cw;
        waitToolName = cwTool;
        isThinking = false;
      } else if (ct && !waitState) {
        isThinking = true;
      }
    }
    return { waitState, waitToolName, isThinking, subagents };
  }

  buildConversationCard(entry, globalObservedCeiling, subagentTokens) {
    const verbatimPrompts = entry.compactCount > 0
      ? Math.min(10, entry.promptCount)
      : entry.promptCount;
    const compactedPrompts = entry.compactCount > 0
      ? Math.max(0, entry.promptCount - 10)
      : 0;
    const pollution = classifyPollution(entry.compactCount, compactedPrompts);
    const localCeiling = computeMedian((entry.compactTriggerTokens || []).slice(-10));
    const observedCeiling = localCeiling || globalObservedCeiling || 0;
    const currentTokens = entry.currentTokens || 0;
    const ceilingExceeded = observedCeiling > 0 && currentTokens > observedCeiling;
    const contextRatio = observedCeiling > 0 && !ceilingExceeded
      ? Math.min(1, currentTokens / observedCeiling)
      : null;

    const drift = this.gitCache.computeDriftForConversation(entry);
    const meta = this.resolveEntryDisplayMeta(entry);

    const { waitState, waitToolName, isThinking, subagents } = this.resolveSubagentsState(entry);

    // Blue dot rule: the last step is a finished reply (no tool calls, not RUNNING), nothing is thinking
    // or waiting, and that reply is newer than every "seen" signal. Seen is only raised by an explicit
    // Cockpit open (POST /api/conversation-seen), by the claim-holding iframe when its chat completes,
    // or by viewedConvId, which ui.html only sends from the claim holder. Hidden aux pane iframes keep
    // polling, so a new server-side seen path that ignores the claim will eat dots (see ui.html notes
    // above ACTIVE_CONV_STORAGE_KEY).
    const seenBaselineMs = Math.max(
      entry.lastSeenMs || 0,
      entry.lastViewMs || 0,
      entry.lastUserInputMs || 0
    );
    const unread = Boolean(
      !isThinking &&
      !waitState &&
      (((entry.lastModelResponseMs || 0) > 0 && (entry.lastModelResponseMs || 0) > seenBaselineMs) ||
        entry.markedAsUnread)
    );

    const pinnedAtMs = this.pinnedConversations.get(entry.id) || 0;
    const pinned = pinnedAtMs > 0;

    const awaitingHandoffResponse = Boolean(
      entry.awaitingHandoffResponse ||
      entry.needsFullHandoffRead ||
      (entry.handoffRpcPendingMs && Date.now() - entry.handoffRpcPendingMs < 30000)
    );

    return {
      id: entry.id,
      isSubagent: !!entry.isSubagent,
      subagentTokens: subagentTokens ? (subagentTokens.get(entry.id) || 0) : 0,
      subagents,
      projectId: meta.projectId,
      workspacePath: meta.workspacePath,
      workspaceKey: meta.workspaceKey,
      workspaceName: meta.workspaceName,
      lastActiveIso: entry.lastActiveIso || '',
      lastActiveMs: entry.lastActiveMs || 0,
      lastUserInputMs: entry.lastUserInputMs || 0,
      lastViewMs: entry.lastViewMs || 0,
      lastSeenMs: entry.lastSeenMs || 0,
      latestHandoffMs: entry.latestHandoffMs || 0,
      latestHandoffPrompt: entry.latestHandoffPrompt || '',
      awaitingHandoffResponse,
      compactCount: entry.compactCount || 0,
      lastCompactMs: entry.lastCompactMs || 0,
      promptsSinceLastCompact: entry.promptsSinceLastCompact || 0,
      pollution,
      promptCount: entry.promptCount || 0,
      verbatimPrompts,
      compactedPrompts,
      currentTokens,
      totalInputTokens: entry.totalInputTokens || 0,
      totalCacheReadTokens: entry.totalCacheReadTokens || 0,
      totalOutputTokens: entry.totalOutputTokens || 0,
      totalTokens: entry.totalTokens || 0,
      observedCeiling,
      ceilingExceeded,
      contextRatio,
      pinned,
      pinnedAtMs,
      customTitle: meta.customTitle,
      defaultTitle: meta.defaultTitle,
      title: meta.title,
      firstPrompt: entry.firstPrompt || '',
      lastPrompt: entry.lastPrompt || '',
      lastModelResponse: entry.lastModelResponse || '',
      lastModelResponseMs: entry.lastModelResponseMs || 0,
      isThinking,
      waitState,
      waitToolName,
      unread,
      modelEnum: entry.modelEnum || '',
      modelLabel: entry.modelLabel || this.lookupModelLabel(entry.modelEnum) || '',
      git: {
        hasGit: drift.hasGit,
        commitsBehind: drift.commitsBehind
      }
    };
  }

  handleStatusRequest(query) {
    let workspaceUris = [];
    if (query.workspaceUris) {
      try {
        workspaceUris = JSON.parse(query.workspaceUris);
      } catch {
        workspaceUris = [query.workspaceUris];
      }
    }

    const isForce = query.force === '1';
    if (isForce) {
      this.gitCache.invalidateMtimeChecks();
    }

    const hostConvId = (
      query.activeConvId ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      ''
    ).trim().toLowerCase();

    this.refreshProjectsRegistry(isForce);
    const hasProjectsRegistry = this.projectsRegistry.size > 0;

    const { sortedEntries, subagentTokens, globalObservedCeiling } = this.refreshIndex({
      activeConvId: hostConvId,
      workspaceUris,
      force: isForce
    });

    const viewedConvId = (query.viewedConvId || '').trim().toLowerCase();
    if (UUID_RE.test(viewedConvId)) {
      const viewedEntry = this.convCache.get(viewedConvId);
      const viewedState = viewedEntry ? this.resolveSubagentsState(viewedEntry) : null;
      // Guard !viewedEntry.markedAsUnread on the server too: an /api/status?viewedConvId=... poll can
      // already be in flight with stale client state when the user clicks "Mark as unread".
      if (viewedEntry && !viewedEntry.markedAsUnread && viewedState && !viewedState.isThinking && !viewedState.waitState) {
        const myFocusMs = Math.max(viewedEntry.lastViewMs || 0, viewedEntry.lastUserInputMs || 0);
        let newerFocusElsewhere = false;
        for (const e of sortedEntries) {
          if (e.isSubagent || e.archived || e.id === viewedConvId) continue;
          const otherFocusMs = Math.max(e.lastViewMs || 0, e.lastUserInputMs || 0);
          if (otherFocusMs > myFocusMs) {
            newerFocusElsewhere = true;
            break;
          }
        }
        if (!newerFocusElsewhere) {
          this.markConversationSeen(viewedConvId);
        }
      }
    }

    if (this.isTraceEnabled()) {
      const traceNow = Date.now();
      const rows = [];
      for (const e of sortedEntries) {
        if (e.isSubagent) continue;
        const st = this.resolveSubagentsState(e);
        const baseline = Math.max(e.lastSeenMs || 0, e.lastViewMs || 0, e.lastUserInputMs || 0);
        const unread = Boolean(
          !st.isThinking && !st.waitState &&
          (((e.lastModelResponseMs || 0) > baseline) || e.markedAsUnread)
        );
        const recent = Math.max(e.lastViewMs || 0, e.lastUserInputMs || 0, e.lastModelResponseMs || 0) > traceNow - 10 * 60 * 1000;
        if (!recent && !unread && !st.isThinking) continue;
        rows.push([
          e.id.slice(0, 8), st.isThinking ? 'T' : (st.waitState || '-'), unread ? 'U' : '-',
          e.lastStepType, e.lastStepIsCompletedReply ? 'C' : '-',
          e.lastUserInputMs || 0, e.lastViewMs || 0, e.lastSeenMs || 0, e.lastModelResponseMs || 0
        ]);
      }
      const sig = JSON.stringify([hostConvId, viewedConvId, rows]);
      if (sig !== this.lastTraceSig) {
        this.lastTraceSig = sig;
        this.debugTrace({
          ev: 'status', activeConvId: hostConvId.slice(0, 8), viewedConvId: viewedConvId.slice(0, 8),
          cols: 'id,state,unread,lastStep,completed,userIn,view,seen,resp', rows
        });
      }
    }

    const detectedActiveWorkspaceNorm = workspaceUris.length > 0
      ? resolveCanonicalWorkspace(workspaceUris[0])
      : (sortedEntries.find((e) => e.id === hostConvId)?.workspacePath || '');

    const matchedActiveProj = this.matchProjectForWorkspace(detectedActiveWorkspaceNorm);
    const activeWorkspaceKey = matchedActiveProj
      ? (matchedActiveProj.archived ? '' : (matchedActiveProj.primaryKey || matchedActiveProj.id))
      : (hasProjectsRegistry && detectedActiveWorkspaceNorm ? '' : workspaceComparisonKey(detectedActiveWorkspaceNorm));

    this.gitCache.checkKnownRepos(isForce);
    this.checkAgyBinaryChanged(isForce);
    if (
      this.pluginUpdateState.checkedAtMs > 0 &&
      Date.now() - this.pluginUpdateState.checkedAtMs >= PLUGIN_UPDATE_CHECK_INTERVAL_MS
    ) {
      void this.checkPluginUpdate(false);
    }

    const checkNowMs = Date.now();
    if (this.cachedCardsState && Array.isArray(this.cachedCardsState.cards)) {
      for (let i = 0; i < this.cachedCardsState.cards.length; i++) {
        const c = this.cachedCardsState.cards[i];
        const e = this.cachedCardsState.visibleEntries[i];
        if (!c || !e) continue;
        const st = this.resolveSubagentsState(e, checkNowMs);
        const subChanged =
          c.subagents.length !== st.subagents.length ||
          c.subagents.some((s, idx) => s.isThinking !== st.subagents[idx].isThinking || s.waitState !== st.subagents[idx].waitState);
        if (subChanged || Boolean(c.isThinking) !== st.isThinking || (c.waitState || '') !== st.waitState) {
          this.cachedCardsState = null;
          break;
        }
      }
    }

    let visibleEntries;
    let cards;
    let workspaces;
    let archivedProjects;
    let archivedConversations;
    if (
      !isForce &&
      this.cachedCardsState &&
      this.cachedCardsState.transcriptRev === this.transcriptRev &&
      this.cachedCardsState.projectsRev === this.projectsRev &&
      this.cachedCardsState.gitRev === this.gitCache.revision &&
      this.cachedCardsState.modelsCatalogRev === this.modelsCatalogRev &&
      this.cachedCardsState.diagnosticsRev === this.diagnosticsRev &&
      this.cachedCardsState.pluginUpdateRev === this.pluginUpdateRev &&
      this.cachedCardsState.activeWorkspaceKey === activeWorkspaceKey
    ) {
      visibleEntries = this.cachedCardsState.visibleEntries;
      cards = this.cachedCardsState.cards;
      workspaces = this.cachedCardsState.workspaces;
      archivedProjects = this.cachedCardsState.archivedProjects;
      archivedConversations = this.cachedCardsState.archivedConversations || [];
    } else {
      const archivedConvCounts = new Map();
      const hiddenMainItems = [];
      archivedConversations = [];
      visibleEntries = sortedEntries.filter((e) => {
        if (e.isSubagent) return false;
        if (e.archived) {
          const meta = this.resolveEntryDisplayMeta(e);
          archivedConversations.push({
            id: e.id,
            title: meta.title,
            customTitle: meta.customTitle,
            defaultTitle: meta.defaultTitle,
            firstPrompt: e.firstPrompt || '',
            lastPrompt: e.lastPrompt || '',
            workspaceName: meta.workspaceName,
            lastActiveMs: e.lastActiveMs || 0
          });
          hiddenMainItems.push([e.id, e.lastActiveMs, e.latestHandoffMs, e.currentTokens, e.totalTokens, e.promptCount, e.compactCount]);
          return false;
        }
        if (hasProjectsRegistry && (e.projectId || e.workspacePath)) {
          const proj =
            (e.projectId && this.projectsRegistry.get(e.projectId)) ||
            this.matchProjectForWorkspace(e.workspacePath);
          if (!proj) {
            hiddenMainItems.push([e.id, e.lastActiveMs, e.latestHandoffMs, e.currentTokens, e.totalTokens, e.promptCount, e.compactCount]);
            return false;
          }
          if (proj.archived) {
            archivedConvCounts.set(proj.id, (archivedConvCounts.get(proj.id) || 0) + 1);
            hiddenMainItems.push([e.id, e.lastActiveMs, e.latestHandoffMs, e.currentTokens, e.totalTokens, e.promptCount, e.compactCount]);
            return false;
          }
        }
        return true;
      });

      cards = visibleEntries.map((entry) =>
        this.buildConversationCard(entry, globalObservedCeiling, subagentTokens)
      );

      const workspaceMap = new Map();
      for (const c of cards) {
        if (c.isSubagent) continue;
        const key = c.workspaceKey || '__unscoped__';
        const activityMs = Math.max(c.lastActiveMs || 0, c.lastViewMs || 0);
        const existing = workspaceMap.get(key);
        if (existing) {
          existing.count += 1;
          if (activityMs > existing.lastActiveMs) {
            existing.lastActiveMs = activityMs;
          }
          if (!existing.projectId && c.projectId) {
            existing.projectId = c.projectId;
          }
        } else {
          workspaceMap.set(key, {
            key,
            projectId: c.projectId || '',
            path: c.workspacePath || '',
            name: c.workspaceName,
            count: 1,
            lastActiveMs: activityMs
          });
        }
      }
      if (matchedActiveProj && !matchedActiveProj.archived) {
        const activeKey = matchedActiveProj.primaryKey || matchedActiveProj.id;
        if (activeKey && !workspaceMap.has(activeKey)) {
          workspaceMap.set(activeKey, {
            key: activeKey,
            projectId: matchedActiveProj.id,
            path: matchedActiveProj.primaryPath || detectedActiveWorkspaceNorm || '',
            name: matchedActiveProj.name,
            count: 0,
            lastActiveMs: Date.now()
          });
        }
      }
      for (const proj of this.projectsRegistry.values()) {
        if (proj.archived || proj.isWorkspaceOnly || !proj.primaryPath) continue;
        const projKey = proj.primaryKey || proj.id;
        if (projKey && !workspaceMap.has(projKey)) {
          workspaceMap.set(projKey, {
            key: projKey,
            projectId: proj.id,
            path: proj.primaryPath,
            name: proj.name,
            count: 0,
            lastActiveMs: Math.floor(this.projectFileMtimes.get(proj.id) || 0)
          });
        }
      }
      workspaces = [...workspaceMap.values()].sort((a, b) => {
        if (a.key === '__unscoped__') return 1;
        if (b.key === '__unscoped__') return -1;
        return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
      });

      archivedProjects = [];
      for (const proj of this.projectsRegistry.values()) {
        if (proj.archived) {
          archivedProjects.push({
            id: proj.id,
            name: proj.name,
            path: proj.primaryPath || '',
            key: proj.primaryKey || proj.id,
            count: archivedConvCounts.get(proj.id) || 0
          });
        }
      }
      archivedProjects.sort((a, b) => a.name.localeCompare(b.name));

      const signature = JSON.stringify({
        globalObservedCeiling,
        projectsRev: this.projectsRev,
        modelsCatalogRev: this.modelsCatalogRev,
        diagnosticsRev: this.diagnosticsRev,
        pluginUpdateRev: this.pluginUpdateRev,
        activeWorkspaceKey,
        archivedIds: archivedProjects.map((p) => [p.id, p.count]),
        archivedConvIds: archivedConversations.map((c) => [c.id, c.title, c.lastActiveMs]),
        hiddenMainItems,
        items: cards.map((c) => [
          c.id,
          c.title,
          c.customTitle,
          c.pinned,
          c.pinnedAtMs,
          c.lastActiveMs,
          c.lastUserInputMs,
          c.lastViewMs,
          c.lastSeenMs,
          c.latestHandoffMs,
          c.awaitingHandoffResponse,
          c.compactCount,
          c.pollution.id,
          c.promptCount,
          c.currentTokens,
          c.totalTokens,
          c.subagentTokens,
          c.workspaceKey,
          c.projectId,
          c.modelEnum,
          c.modelLabel,
          c.lastPrompt,
          c.lastModelResponse,
          c.lastModelResponseMs,
          c.isThinking,
          c.waitState,
          c.waitToolName,
          c.unread,
          c.git.commitsBehind,
          c.subagents.map((s) => [s.id, s.title, s.totalTokens, s.isThinking, s.waitState, s.waitToolName])
        ])
      });

      if (signature !== this.lastStateSignature) {
        this.lastStateSignature = signature;
        this.stateVersion += 1;
      }

      this.cachedCardsState = {
        transcriptRev: this.transcriptRev,
        projectsRev: this.projectsRev,
        gitRev: this.gitCache.revision,
        modelsCatalogRev: this.modelsCatalogRev,
        diagnosticsRev: this.diagnosticsRev,
        pluginUpdateRev: this.pluginUpdateRev,
        activeWorkspaceKey,
        visibleEntries,
        cards,
        workspaces,
        archivedProjects,
        archivedConversations
      };
    }

    if (isForce) {
      void this.refreshQuotaSummary({ maxAgeMs: 15000 });
      void this.syncTrajectoriesFromLanguageServer(true);
    }
    this.triggerBackgroundModelResolution(hostConvId, visibleEntries);

    const now = Date.now();
    if (isForce || now - this.lastUiStatCheckMs >= 2000) {
      this.lastUiStatCheckMs = now;
      try {
        this.cachedUiMtimeMs = Math.floor(fs.statSync(this.uiHtmlPath, { throwIfNoEntry: false })?.mtimeMs || 0);
      } catch {}
      if (this.bootScriptMtimeMs > 0) {
        try {
          const curScriptMtime = fs.statSync(__filename, { throwIfNoEntry: false })?.mtimeMs || 0;
          if (curScriptMtime > 0 && curScriptMtime !== this.bootScriptMtimeMs) {
            this.scriptChangedOnDisk = true;
          }
        } catch {}
      }
    }
    const uiMtimeMs = this.cachedUiMtimeMs;

    const clientVersion = parseInt(query.sinceVersion || '0', 10);
    if (clientVersion > 0 && clientVersion === this.stateVersion && !isForce && !query.simulateDiag) {
      return {
        unchanged: true,
        version: this.stateVersion,
        uiMtimeMs,
        traceEnabled: this.isTraceEnabled(),
        refreshMs: Number(this.lastRefreshDurationMs.toFixed(2))
      };
    }

    if (
      UUID_RE.test(hostConvId) &&
      !this.deletedConvIds.has(hostConvId) &&
      !cards.some((c) => c.id === hostConvId)
    ) {
      const isWorkspaceVisible = (wsPath, projId = '') => {
        if (!hasProjectsRegistry || (!wsPath && !projId)) return true;
        const proj =
          (projId && this.projectsRegistry.get(projId)) ||
          this.matchProjectForWorkspace(wsPath);
        return Boolean(proj && !proj.archived);
      };
      const hostEntry = sortedEntries.find((e) => e.id === hostConvId);
      if (
        hostEntry &&
        !hostEntry.archived &&
        !hostEntry.isSubagent &&
        isWorkspaceVisible(hostEntry.workspacePath, hostEntry.projectId)
      ) {
        cards = [this.buildConversationCard(hostEntry, globalObservedCeiling, subagentTokens), ...cards];
      } else if (!hostEntry) {
        const lsMeta = this.lsTrajectoryMeta.get(hostConvId);
        const cachedMeta = this.metadataWorkspaceCache.get(hostConvId);
        let candidateProjId = '';
        let candidateWs = '';
        if (lsMeta) {
          candidateProjId = lsMeta.projectId || '';
          candidateWs = lsMeta.workspacePath || '';
        } else if (cachedMeta && typeof cachedMeta === 'object') {
          candidateProjId = cachedMeta.projectId || '';
          candidateWs = cachedMeta.workspacePath || '';
        } else if (typeof cachedMeta === 'string' && cachedMeta && cachedMeta !== '__general__') {
          candidateWs = cachedMeta;
        }
        if (isWorkspaceVisible(candidateWs, candidateProjId)) {
          const placeholderEntry = createEmptyEntry(hostConvId);
          placeholderEntry.projectId = candidateProjId;
          placeholderEntry.workspacePath = candidateWs;
          cards = [this.buildConversationCard(placeholderEntry, globalObservedCeiling, subagentTokens), ...cards];
        }
      }
    }

    let searchMatches = null;
    const rawSearch = normalizeSearchText(query.q || '');
    if (rawSearch) {
      searchMatches = {};
      for (const entry of visibleEntries) {
        const customTitleNorm = normalizeSearchText(this.customTitles.get(entry.id) || '');
        const corpusHit = Boolean(entry.searchCorpusLower && entry.searchCorpusLower.includes(rawSearch));
        const customTitleHit = Boolean(customTitleNorm && customTitleNorm.includes(rawSearch));
        if (!corpusHit && !customTitleHit) continue;
        const matchingPrompts = [];
        for (const p of entry.prompts) {
          if (normalizeSearchText(p.text).includes(rawSearch)) {
            matchingPrompts.push({
              index: p.index,
              label: '#' + p.index,
              createdAt: p.createdAt,
              text: buildCenteredSearchSnippet(p.text, rawSearch, 160)
            });
            if (matchingPrompts.length >= 3) break;
          }
        }
        if (matchingPrompts.length === 0) {
          if (entry.checkpointOverview && normalizeSearchText(entry.checkpointOverview).includes(rawSearch)) {
            matchingPrompts.push({
              index: 0,
              label: 'Summary',
              createdAt: '',
              text: buildCenteredSearchSnippet(entry.checkpointOverview, rawSearch, 160)
            });
          } else if (entry.firstPrompt && normalizeSearchText(entry.firstPrompt).includes(rawSearch)) {
            matchingPrompts.push({
              index: 1,
              label: '#1',
              createdAt: '',
              text: buildCenteredSearchSnippet(entry.firstPrompt, rawSearch, 160)
            });
          } else if (entry.lastPrompt && normalizeSearchText(entry.lastPrompt).includes(rawSearch)) {
            const fallbackIdx = entry.promptCount || 1;
            matchingPrompts.push({
              index: fallbackIdx,
              label: '#' + fallbackIdx,
              createdAt: '',
              text: buildCenteredSearchSnippet(entry.lastPrompt, rawSearch, 160)
            });
          } else if (
            entry.title &&
            customTitleNorm &&
            !customTitleHit &&
            normalizeSearchText(entry.title).includes(rawSearch)
          ) {
            matchingPrompts.push({
              index: 0,
              label: 'Default title',
              createdAt: '',
              text: buildCenteredSearchSnippet(entry.title, rawSearch, 160)
            });
          }
        }
        searchMatches[entry.id] = {
          matchingPrompts
        };
      }
    }

    return {
      unchanged: false,
      version: this.stateVersion,
      uiMtimeMs,
      traceEnabled: this.isTraceEnabled(),
      refreshMs: Number(this.lastRefreshDurationMs.toFixed(2)),
      hostConversationId: hostConvId || null,
      activeWorkspaceKey: activeWorkspaceKey || '',
      availableModels: this.cachedModelsCatalog.models,
      defaultModelEnum: this.cachedModelsCatalog.defaultModelEnum || '',
      quota: this.cachedQuota,
      diagnostics: this.getDiagnosticsStatusPayload(query),
      pluginUpdate: this.getPluginUpdatePayload(),
      workspaces,
      archivedProjects,
      archivedConversations,
      conversations: cards,
      searchMatches
    };
  }

  handleConversationDetails(query) {
    const convId = (query.id || '').trim().toLowerCase();
    if (!UUID_RE.test(convId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const entry = this.refreshSingleEntry(convId);
    if (!entry) {
      return { status: 404, body: { error: 'Conversation not found' } };
    }
    const drift = this.gitCache.computeDriftForConversation(entry);
    return {
      status: 200,
      body: {
        id: entry.id,
        checkpointOverview: entry.checkpointOverview,
        prompts: [...entry.prompts].reverse(),
        missedCommits: drift.missedCommits,
        commitsBehind: drift.commitsBehind
      }
    };
  }

  getGlobalObservedCeiling() {
    if (this.cachedIndexSummary && this.cachedIndexSummary.globalObservedCeiling > 0) {
      return this.cachedIndexSummary.globalObservedCeiling;
    }
    const allRecentCompactTokens = [];
    const sortedEntries = [...this.convCache.values()].sort(
      (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0)
    );
    for (const e of sortedEntries) {
      if (Array.isArray(e.compactTriggerTokens) && e.compactTriggerTokens.length > 0) {
        allRecentCompactTokens.push(...e.compactTriggerTokens.slice(-5));
        if (allRecentCompactTokens.length >= 25) break;
      }
    }
    return computeMedian(allRecentCompactTokens);
  }

  handleContextBreakdown(query) {
    const convId = (query.id || '').trim().toLowerCase();
    if (!UUID_RE.test(convId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const entry = this.refreshSingleEntry(convId) || this.convCache.get(convId) || null;
    const transcriptPath = path.join(this.brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!entry && !isFile(transcriptPath)) {
      return { status: 404, body: { error: 'Conversation not found' } };
    }
    const localCeiling = entry ? computeMedian((entry.compactTriggerTokens || []).slice(-10)) : 0;
    const observedCeiling = localCeiling || this.getGlobalObservedCeiling() || 0;
    const body = buildContextBreakdownForTranscript(convId, transcriptPath, entry, observedCeiling);
    return { status: 200, body };
  }

  handleHandoffSummary(query) {
    const convId = (query.id || '').trim().toLowerCase();
    const focusTopic = (query.focus || '').trim();
    if (!UUID_RE.test(convId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const entry = this.refreshSingleEntry(convId);
    if (!entry) {
      return { status: 404, body: { error: 'Conversation not found' } };
    }

    void this.resolveConversationModelAsync(convId, false);
    const promptForAgentHandoff = buildAgentHandoffRequest(entry, focusTopic);
    return {
      status: 200,
      body: {
        id: entry.id,
        compactCount: entry.compactCount,
        modelEnum: entry.modelEnum || '',
        modelLabel: entry.modelLabel || this.lookupModelLabel(entry.modelEnum),
        latestHandoffMs: entry.latestHandoffMs || 0,
        latestHandoffPrompt: entry.latestHandoffPrompt || '',
        promptForAgentHandoff
      }
    };
  }

  validateToken(req, urlObj) {
    if (urlObj.pathname === '/preload.js') return true;
    if (!this.token) return true;
    const headerTok = req.headers['x-sidecar-token'];
    const queryTok = urlObj.searchParams.get('token');
    return headerTok === this.token || queryTok === this.token;
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > 10 * 1024 * 1024) {
          reject(new Error('Payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  async handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://${BIND_HOST}:${this.port || DEFAULT_PORT}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/ui.html')) {
      try {
        const rawHtml = fs.readFileSync(this.uiHtmlPath, 'utf-8');
        const reqToken =
          urlObj.searchParams.get('token')?.trim() ||
          (typeof req.headers['x-sidecar-token'] === 'string' ? req.headers['x-sidecar-token'].trim() : '') ||
          this.token;
        const reqConvId =
          urlObj.searchParams.get('conversationId')?.trim() ||
          process.env.ANTIGRAVITY_CONVERSATION_ID ||
          '';
        const body = rewriteUiHtmlLinks(rawHtml, reqToken, reqConvId);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Failed to load ui.html: ${err.message}`);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(this.loadPreloadJs());
      return;
    }

    if (req.method !== 'GET' && !this.validateToken(req, urlObj)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const query = Object.fromEntries(urlObj.searchParams.entries());

    if (req.method === 'GET' && pathname === '/api/status') {
      if (this.restartingForUpdate) {
        sendJson(res, 503, { error: 'restarting' });
        return;
      }
      if (!this.trajectoriesInitialSyncDone) {
        await this.syncTrajectoriesFromLanguageServer(false);
      }
      const payload = this.handleStatusRequest(query);
      sendJson(res, 200, payload);
      if (this.scriptChangedOnDisk && this.bootScriptMtimeMs > 0) {
        this.bootScriptMtimeMs = 0;
        setImmediate(() => {
          this.stop().finally(() => process.exit(0));
        });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      const report = await this.runDiagnostics({
        refresh: query.refresh === '1',
        simulate: query.simulate || ''
      });
      sendJson(res, 200, report);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/plugin-update') {
      const { status, body } = await this.applyPluginUpdate();
      sendJson(res, status, body);
      if (body?.updated && this.bootScriptMtimeMs > 0) {
        this.restartingForUpdate = true;
        this.bootScriptMtimeMs = 0;
        setTimeout(() => this.stop().finally(() => process.exit(0)), 100).unref?.();
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conversation-details') {
      const { status, body } = this.handleConversationDetails(query);
      sendJson(res, status, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/context-breakdown') {
      const { status, body } = this.handleContextBreakdown(query);
      sendJson(res, status, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/handoff-summary') {
      const { status, body } = this.handleHandoffSummary(query);
      sendJson(res, status, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/quota') {
      const forceRemote = query.refresh === '1';
      const quota = await this.refreshQuotaSummary({ maxAgeMs: forceRemote ? 5000 : 60000, forceRemote });
      sendJson(res, 200, { quota: quota || null, version: this.stateVersion });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/models') {
      const forceRefresh = query.refresh === '1';
      const catalog = await this.getModelsCatalog(forceRefresh);
      const qConvId = typeof query.convId === 'string' ? query.convId.trim().toLowerCase() : '';
      let convModelEnum = '';
      let convModelLabel = '';
      if (UUID_RE.test(qConvId)) {
        const resolvedEnum = await this.resolveConversationModelAsync(qConvId, forceRefresh);
        const entry = this.convCache.get(qConvId);
        convModelEnum = resolvedEnum || (entry && entry.modelEnum) || '';
        convModelLabel = (entry && entry.modelLabel) || this.lookupModelLabel(convModelEnum);
      }
      sendJson(res, 200, {
        models: catalog.models || [],
        defaultModelEnum: catalog.defaultModelEnum || '',
        convId: qConvId || '',
        convModelEnum,
        convModelLabel
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/project-archive') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = this.setProjectArchived(body.projectId, body.archived);
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/debug-trace') {
      const body = await this.readJsonBody(req);
      if (this.isTraceEnabled()) {
        for (const line of Array.isArray(body.lines) ? body.lines.slice(0, 500) : []) {
          if (line && typeof line === 'object') {
            this.debugTrace(Object.assign({}, line, { srvT: Date.now() }));
          }
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-seen') {
      const body = await this.readJsonBody(req);
      const convId = typeof body.conversationId === 'string' ? body.conversationId.trim().toLowerCase() : '';
      if (!UUID_RE.test(convId)) {
        sendJson(res, 400, { error: 'Invalid conversationId' });
        return;
      }
      const changed = this.markConversationSeen(convId, true);
      sendJson(res, 200, { ok: true, conversationId: convId, changed });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-unread') {
      const body = await this.readJsonBody(req);
      const targetId = body.conversationId || body.id || '';
      const { status, body: outBody } = await this.setConversationUnread(
        targetId,
        body.unread !== false
      );
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-archive') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = await this.setConversationArchived(
        body.conversationId,
        body.archived
      );
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-delete') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = await this.deleteConversation(body.conversationId || body.id);
      sendJson(res, status, outBody);
      return;
    }

    if (
      req.method === 'POST' &&
      (pathname === '/api/pin-conversation' || pathname === '/api/conversation-pin')
    ) {
      const body = await this.readJsonBody(req);
      const targetId = body.id || body.conversationId || '';
      const { status, body: outBody } = this.setConversationPinned(targetId, body.pinned);
      sendJson(res, status, outBody);
      return;
    }

    if (
      req.method === 'POST' &&
      (pathname === '/api/rename-conversation' || pathname === '/api/conversation-rename')
    ) {
      const body = await this.readJsonBody(req);
      const targetId = body.id || body.conversationId || '';
      const { status, body: outBody } = await this.setConversationCustomTitle(targetId, body.title);
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cancel-invocation') {
      const body = await this.readJsonBody(req);
      const rawId = body.conversationId || body.id || '';
      const convId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
      if (!UUID_RE.test(convId)) {
        sendJson(res, 400, { error: 'Invalid conversationId' });
        return;
      }
      const entry = this.convCache.get(convId);
      if (entry) {
        entry.lastStepStatus = 'CANCELED';
        entry.awaitingHandoffResponse = false;
        entry.handoffRpcPendingMs = 0;
        entry.lastHandoffStepIndex = -1;
        entry.needsFullHandoffRead = false;
        entry.handoffTargetStepIndex = -1;
        this.markTranscriptDirty({ resetSummary: false, saveIndex: true, bumpStateVersion: true });
      }
      const rpcRes = await callLanguageServerRpc('CancelCascadeInvocation', { cascadeId: convId }, 4000);
      sendJson(res, 200, { ok: Boolean(!rpcRes || !rpcRes.error) });
      return;
    }

    if (req.method === 'POST' && pathname === '/_sidecar/send-message') {
      const body = await this.readJsonBody(req);
      const convId = (body.conversationId || '').trim();
      const message = typeof body.message === 'string' ? body.message : '';
      if (!UUID_RE.test(convId) || !message) {
        sendJson(res, 400, { error: 'Invalid conversationId or empty message' });
        return;
      }
      const cleanConvId = convId.toLowerCase();
      const transcriptPath = path.join(this.brainDir, cleanConvId, '.system_generated', 'logs', 'transcript.jsonl');
      let preSendSize = 0;
      let preSendMtimeMs = 0;
      try {
        const st = fs.statSync(transcriptPath, { throwIfNoEntry: false });
        if (st) {
          preSendSize = st.size || 0;
          preSendMtimeMs = st.mtimeMs || 0;
        }
      } catch {}
      const isHandoffMessage = isSmartHandoffRequestText(message);
      const preTarget = this.convCache.get(cleanConvId);
      if (preTarget && isHandoffMessage) {
        preTarget.handoffRpcPendingMs = Date.now();
        this.markTranscriptDirty({ resetSummary: true, saveIndex: false });
      }
      const markSentSuccess = () => {
        const target = this.convCache.get(cleanConvId);
        if (target) {
          const nowMs = Date.now();
          target.lastActiveIso = new Date(nowMs).toISOString();
          target.lastActiveMs = Math.max(target.lastActiveMs || 0, nowMs);
          if (isHandoffMessage && !target.awaitingHandoffResponse) {
            target.handoffRpcPendingMs = nowMs;
          }
          this.markTranscriptDirty({ resetSummary: true, saveIndex: false });
        }
      };
      const sendRpc = await callLanguageServerRpc(
        'SendUserCascadeMessage',
        {
          cascadeId: cleanConvId,
          items: [{ text: message }],
          metadata: {},
          clientType: 'CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE'
        },
        15000
      );
      if (sendRpc && !sendRpc.error) {
        markSentSuccess();
        sendJson(res, 200, { response: sendRpc });
        return;
      }
      let acceptedOnDisk = false;
      try {
        const postSt = fs.statSync(transcriptPath, { throwIfNoEntry: false });
        if (postSt && (postSt.size > preSendSize || postSt.mtimeMs > preSendMtimeMs)) {
          acceptedOnDisk = true;
        }
      } catch {}
      if (acceptedOnDisk) {
        this.refreshSingleEntry(cleanConvId);
        markSentSuccess();
        sendJson(res, 200, { response: { ok: true, acceptedOnTranscript: true } });
        return;
      }
      this.refreshProjectsRegistry(false);
      const entry = this.convCache.get(cleanConvId) || this.refreshSingleEntry(cleanConvId);
      const wsPath = (typeof body.workspacePath === 'string' && body.workspacePath.trim()) || (entry && entry.workspacePath) || '';
      const matchedProj = wsPath ? this.matchProjectForWorkspace(wsPath) : null;
      const effectiveProjectId =
        (typeof body.projectId === 'string' && body.projectId.trim()) ||
        (matchedProj ? matchedProj.id : '');
      const nativeWsPath = wsPath && process.platform === 'win32' ? wsPath.replace(/\//g, '\\') : wsPath;
      const out = await execAgentApi(['send-message', convId, message], effectiveProjectId, this.appDataDir, nativeWsPath);
      if (out && out.error) {
        const target = this.convCache.get(cleanConvId);
        if (target && isHandoffMessage) {
          target.handoffRpcPendingMs = 0;
          this.markTranscriptDirty({ resetSummary: true, saveIndex: false });
        }
        sendJson(res, 502, out);
        return;
      }
      markSentSuccess();
      sendJson(res, 200, out);
      return;
    }

    if (req.method === 'POST' && pathname === '/_sidecar/new-conversation') {
      const body = await this.readJsonBody(req);
      const message = typeof body.message === 'string' ? body.message : '';
      if (!message) {
        sendJson(res, 400, { error: 'Empty message' });
        return;
      }
      this.refreshProjectsRegistry(true);
      const catalog = await this.getModelsCatalog(false);
      const isGeneral = Boolean(body.general);
      const srcConvId = typeof body.conversationId === 'string' ? body.conversationId.trim().toLowerCase() : '';
      const srcEntry = UUID_RE.test(srcConvId)
        ? (this.convCache.get(srcConvId) || this.refreshSingleEntry(srcConvId))
        : null;
      const requestedProjectId =
        !isGeneral && typeof body.projectId === 'string' && UUID_RE.test(body.projectId.trim())
          ? body.projectId.trim().toLowerCase()
          : (!isGeneral && srcEntry && srcEntry.projectId && UUID_RE.test(srcEntry.projectId) ? srcEntry.projectId : '');
      const requestedProj = requestedProjectId ? this.projectsRegistry.get(requestedProjectId) : null;
      const rawWsPath = isGeneral
        ? ''
        : ((typeof body.workspacePath === 'string' && body.workspacePath.trim()) ||
           (requestedProj && requestedProj.primaryPath) ||
           (srcEntry && srcEntry.workspacePath) ||
           '');
      const normWsPath = rawWsPath ? resolveCanonicalWorkspace(rawWsPath) : '';
      const matchedProj = requestedProj || (normWsPath ? this.matchProjectForWorkspace(normWsPath) : null) || null;
      const effectiveProjectId = isGeneral
        ? ''
        : (requestedProjectId || (matchedProj ? matchedProj.id : ''));
      const effectiveWsPath = isGeneral
        ? ''
        : ((matchedProj && matchedProj.primaryPath) || normWsPath || '');
      const nativeWsPath =
        effectiveWsPath && process.platform === 'win32'
          ? effectiveWsPath.replace(/\//g, '\\')
          : effectiveWsPath;

      const rawModel = typeof body.model === 'string' ? body.model.trim() : '';
      const rawModelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
      const requestedModelRaw = rawModel || rawModelId || '';
      let matchedModel =
        (rawModel ? this.lookupModelByAny(rawModel) : null) ||
        (rawModelId ? this.lookupModelByAny(rawModelId) : null) ||
        null;
      let selectedModelEnum = matchedModel ? matchedModel.modelEnum : '';
      if (!selectedModelEnum && rawModel.startsWith('MODEL_')) {
        selectedModelEnum = rawModel;
      } else if (!selectedModelEnum && requestedModelRaw.startsWith('MODEL_')) {
        selectedModelEnum = requestedModelRaw;
      }
      if (!selectedModelEnum && srcEntry && srcEntry.modelEnum) {
        selectedModelEnum = srcEntry.modelEnum;
      }
      if (!selectedModelEnum && UUID_RE.test(srcConvId)) {
        selectedModelEnum = await this.resolveConversationModelAsync(srcConvId, false);
      }
      if (!selectedModelEnum && catalog) {
        selectedModelEnum =
          catalog.defaultModelEnum ||
          (Array.isArray(catalog.models) && catalog.models[0] ? catalog.models[0].modelEnum : '') ||
          '';
      }
      if (!matchedModel && selectedModelEnum) {
        matchedModel = this.lookupModelByAny(selectedModelEnum);
      }
      const isAliasModel =
        Boolean(matchedModel && matchedModel.isAlias) ||
        selectedModelEnum.startsWith('MODEL_ALIAS_');
      const selectedModelId = (matchedModel && matchedModel.modelId) || rawModelId || requestedModelRaw || '';
      const selectedModelLabel =
        (matchedModel && matchedModel.label) || this.lookupModelLabel(selectedModelEnum);

      const seedNewConversation = (rawNewId, boundProjectId = effectiveProjectId) => {
        const cleanNewId = (typeof rawNewId === 'string' ? rawNewId : '').trim().toLowerCase();
        if (!cleanNewId || !UUID_RE.test(cleanNewId)) return;
        this.deletedConvIds.delete(cleanNewId);
        const nowMs = Date.now();
        const actualProjId = isGeneral ? '' : (boundProjectId || '');
        const actualWsPath = isGeneral
          ? ''
          : (actualProjId || this.projectsRegistry.size === 0 ? effectiveWsPath : '');
        if (!actualProjId && !actualWsPath) {
          this.metadataWorkspaceCache.set(cleanNewId, '__general__');
          this.saveMetadataCache();
        } else {
          this.metadataWorkspaceCache.set(cleanNewId, {
            projectId: actualProjId,
            workspacePath: actualWsPath
          });
          this.saveMetadataCache();
        }
        this.lsTrajectoryMeta.set(cleanNewId, {
          projectId: actualProjId,
          workspacePath: actualWsPath,
          summary: '',
          annotTitle: ''
        });
        const preEntry = this.convCache.get(cleanNewId) || createEmptyEntry(cleanNewId);
        preEntry.projectId = actualProjId;
        preEntry.workspacePath = actualWsPath;
        if (selectedModelEnum) {
          preEntry.modelEnum = selectedModelEnum;
          preEntry.modelLabel = selectedModelLabel;
          preEntry.modelResolvedMtimeMs = nowMs;
        }
        preEntry.lastActiveIso = new Date(nowMs).toISOString();
        preEntry.lastActiveMs = Math.max(preEntry.lastActiveMs || 0, nowMs);
        preEntry.lastUserInputMs = Math.max(preEntry.lastUserInputMs || 0, nowMs);
        preEntry.lastViewMs = Math.max(preEntry.lastViewMs || 0, nowMs);
        preEntry.lastSeenMs = Math.max(preEntry.lastSeenMs || 0, nowMs);
        if (!preEntry.firstPrompt) {
          preEntry.firstPrompt = message.slice(0, 500);
          preEntry.lastPrompt = preEntry.firstPrompt;
          preEntry.promptCount = Math.max(preEntry.promptCount || 0, 1);
          rebuildSearchCorpus(preEntry);
        }
        this.convCache.set(cleanNewId, preEntry);
        this.markTranscriptDirty();
      };

      const baseStartPayload = {
        source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        ...(selectedModelEnum && !isAliasModel ? { requestedModel: selectedModelEnum } : {})
      };
      const startPayload = { ...baseStartPayload };
      if (nativeWsPath) {
        try {
          startPayload.workspaceUris = [pathToFileURL(nativeWsPath).href];
        } catch {}
      }
      if (effectiveProjectId) {
        startPayload.projectEnvConfig = {
          projectId: effectiveProjectId,
          defaultProjectEnvironment: {}
        };
      }

      let boundProjectId = effectiveProjectId;
      let startRpc = await callLanguageServerRpc('StartCascade', startPayload, 8000);
      if (startRpc.error && effectiveProjectId && startPayload.workspaceUris) {
        const retryProjOnly = {
          ...baseStartPayload,
          projectEnvConfig: startPayload.projectEnvConfig
        };
        startRpc = await callLanguageServerRpc('StartCascade', retryProjOnly, 8000);
      }
      if (startRpc.error && effectiveProjectId) {
        const retryWithoutProject = { ...baseStartPayload };
        if (startPayload.workspaceUris) {
          retryWithoutProject.workspaceUris = startPayload.workspaceUris;
        }
        startRpc = await callLanguageServerRpc('StartCascade', retryWithoutProject, 8000);
        if (!startRpc.error) {
          boundProjectId = '';
        }
      }
      if (startRpc.error && baseStartPayload.requestedModel) {
        const retryWithoutModel = { ...startPayload };
        delete retryWithoutModel.requestedModel;
        if (!boundProjectId && retryWithoutModel.projectEnvConfig) {
          delete retryWithoutModel.projectEnvConfig;
        }
        startRpc = await callLanguageServerRpc('StartCascade', retryWithoutModel, 8000);
      }

      const rawCascadeId =
        (startRpc && typeof startRpc.cascadeId === 'string' && startRpc.cascadeId) ||
        (startRpc && startRpc.data && typeof startRpc.data.cascadeId === 'string' && startRpc.data.cascadeId) ||
        '';
      const cascadeId = rawCascadeId.trim().toLowerCase();
      if (cascadeId && UUID_RE.test(cascadeId)) {
        seedNewConversation(cascadeId, boundProjectId);
        const sendPayload = {
          cascadeId,
          items: [{ text: message }],
          metadata: {},
          clientType: 'CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE'
        };
        if (selectedModelEnum) {
          sendPayload.cascadeConfig = {
            plannerConfig: {
              ...(isAliasModel ? {} : { planModel: selectedModelEnum }),
              requestedModel: isAliasModel
                ? { alias: selectedModelEnum }
                : { model: selectedModelEnum }
            }
          };
        }
        const sendRpc = await callLanguageServerRpc('SendUserCascadeMessage', sendPayload, 12000);
        if (sendRpc && sendRpc.error) {
          const newTranscriptPath = path.join(this.brainDir, cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
          let acceptedOnDisk = false;
          try {
            const st = fs.statSync(newTranscriptPath, { throwIfNoEntry: false });
            acceptedOnDisk = Boolean(st && st.isFile() && st.size > 0);
          } catch {}
          if (!acceptedOnDisk) {
            this.convCache.delete(cascadeId);
            this.lsTrajectoryMeta.delete(cascadeId);
            if (this.metadataWorkspaceCache.delete(cascadeId)) {
              this.saveMetadataCache();
            }
            this.markTranscriptDirty();
            sendJson(res, 502, { error: sendRpc.error, cascadeId });
            return;
          }
          this.refreshSingleEntry(cascadeId);
        }
        this.lastFullScanMs = 0;
        this.lastBrainDirMtimeMs = 0;
        void this.syncTrajectoriesFromLanguageServer(true);
        sendJson(res, 200, {
          response: {
            conversationId: cascadeId,
            cascadeId,
            projectId: boundProjectId,
            modelEnum: selectedModelEnum,
            modelLabel: selectedModelLabel
          }
        });
        return;
      }

      const args = ['new-conversation'];
      if (selectedModelId) {
        args.push('--model', selectedModelId);
      }
      args.push(message);
      const out = await execAgentApi(args, effectiveProjectId, this.appDataDir, nativeWsPath, 12000, isGeneral);
      if (out && out.error) {
        sendJson(res, 502, out);
        return;
      }
      const cliResp = (out && typeof out.response === 'object' && out.response) ? out.response : out;
      const cliConvId = (cliResp && (cliResp.conversationId || cliResp.cascadeId)) || '';
      seedNewConversation(cliConvId, effectiveProjectId);
      this.lastFullScanMs = 0;
      this.lastBrainDirMtimeMs = 0;
      void this.syncTrajectoriesFromLanguageServer(true);
      sendJson(res, 200, out);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  }

  start() {
    if (this.server) return Promise.resolve(this.server);
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        });
      });

      srv.on('error', reject);
      srv.listen(this.port, BIND_HOST, () => {
        this.server = srv;
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        try {
          writeJsonAtomic(
            this.serverInfoPath,
            {
              host: BIND_HOST,
              port: this.port,
              token: this.token || null,
              pid: process.pid
            },
            0o600
          );
        } catch {}
        const diagTimer = setTimeout(() => {
          void this.runDiagnostics({ refresh: false });
        }, 600);
        if (typeof diagTimer.unref === 'function') {
          diagTimer.unref();
        }
        setTimeout(() => void this.checkPluginUpdate(false), 2500).unref?.();
        this.pluginUpdateTimer = setInterval(() => void this.checkPluginUpdate(false), PLUGIN_UPDATE_CHECK_INTERVAL_MS);
        this.pluginUpdateTimer.unref?.();
        resolve(srv);
      });
    });
  }

  async stop() {
    if (this.pluginUpdateTimer) {
      clearInterval(this.pluginUpdateTimer);
      this.pluginUpdateTimer = null;
    }
    if (this.saveCacheTimer || this.indexCacheDirty) {
      this.saveIndexCache();
    }
    try {
      fs.rmSync(this.serverInfoPath, { force: true });
    } catch {}
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

if (require.main === module) {
  const instance = new AgyCockpitServer();
  instance.start().catch((err) => {
    console.error('[agy-cockpit] Fatal startup error:', err);
    process.exit(1);
  });

  const shutdown = () => {
    instance.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  AgyCockpitServer,
  LSRPC_CONTRACT_SPECS,
  resolveLanguageServerBinary,
  scanBinarySymbols,
  updateTranscriptEntry,
  classifyToolCallsWait,
  getEntryWaitState,
  isEntryThinking,
  classifyPollution,
  computeMedian,
  normalizeWorkspacePath,
  resolveCanonicalWorkspace,
  parseGitReflogTail,
  parseCascadeModelConfigs,
  parseUserQuotaSummary,
  buildQuotaFromModelConfigs,
  classifyQuotaWindow,
  estimateRawUtf8Bytes,
  cleanTranscriptArgString,
  buildContextBreakdownForTranscript,
  buildCenteredSearchSnippet
};
