# AGENTS.md

Instructions, installation runbook, and architectural guidelines for AI coding agents working with or installing this repository.

## Project Overview

This repository contains **AGY Cockpit** (`agy-cockpit`), a cross-platform Antigravity Plugin and Sidecar UI Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE` and `SIDECAR_UI_ENTRYPOINT_SIDEBAR`) for **Windows** and **Linux**.

- **Plugin manifest**: [`plugin.json`](./plugin.json)
- **Sidecar source**: [`sidecars/agy-cockpit/`](./sidecars/agy-cockpit) (`sidecar.json`, `server.cjs`, `ui.html`)
- **Cross-platform installer & updater**: [`setup.cjs`](./setup.cjs)

## Opening the Sidecar in Chat

Whenever you install, update, or reference the AGY Cockpit sidecar in a response to the user, always include the clickable sidecar pill link:

[AGY Cockpit](sidecar://agy-cockpit/agy-cockpit/ui.html)

## AI Agent Installation & Update Runbook

When a user asks you to **install** or **update** the `agy-cockpit` plugin on their system (Windows or Linux):

1. **Run the Installer (`node setup.cjs`)**:
   - Execute `node setup.cjs` from the repository root.
   - **Sandbox Note**: `setup.cjs` writes to `~/.gemini/config/plugins/agy-cockpit/` (outside the repository workspace) and sends `SIGTERM` to any running `agy-cockpit` sidecar process so it restarts cleanly. If running inside the Antigravity terminal sandbox blocks access to `~/.gemini/config`, re-run `node setup.cjs` with `BypassSandbox: true`.
2. **Verify Installation & AGY Contracts (`node setup.cjs --check` / `node setup.cjs --doctor`)**:
   - Run `node setup.cjs --check` and confirm that `"pluginInstalled": true`, `"readmeInstalled": true`, and `"sidecarInstalled": true`.
   - Run `node setup.cjs --doctor` (or `node setup.cjs --doctor --json`) to verify that the installed plugin matches the repository byte-for-byte and all 9 Antigravity contracts (`plugin_installation_sync`, `app_data_dirs`, `transcript_schema`, `annotations_pbtxt`, `projects_registry`, `language_server_binary`, `language_server_live_rpc`, `agentapi_cli`, and `sidecar_bridge_and_perf`) pass.
3. **Report Status & Surface the Pill Link**:
   - Include `[AGY Cockpit](sidecar://agy-cockpit/agy-cockpit/ui.html)` in your reply.
   - If the plugin was installed for the **first time** on this machine (the `~/.gemini/config/plugins/agy-cockpit` directory did not previously exist), tell the user to **restart or reload Antigravity** once so Antigravity discovers the new plugin directory.
   - If updating an existing installation (for example after `git pull` or local code edits), no Antigravity restart is required: `node setup.cjs` automatically restarts `server.cjs` and the UI hot-reloads on the next poll.

## Core Invariants & Engineering Rules

1. **HARD RULE: Always Inspect Native Antigravity Tools, Bridge & Language Server RPCs First**:
   - Before proposing, designing, or implementing any feature or workaround, ALWAYS check what native Antigravity tools, `LanguageServerService` RPC methods (by scanning `language_server` binary symbols and probing live RPC responses), `agentapi` CLI subcommands, `window.sidecar` / `preload.js` bridge methods, and on-disk schemas (`~/.gemini/config/projects/*.json`, `annotations/*.pbtxt`, `transcript.jsonl`) exist and what data they provide. Never guess or build a manual workaround before verifying the native surface.
2. **Zero External Dependencies**:
   - Keep `server.cjs` and `setup.cjs` in pure Node.js (`node:fs`, `node:path`, `node:os`, `node:http`, `node:child_process`, `node:url`) with zero npm packages.
3. **Cross-Platform Compatibility (Windows & Linux)**:
   - Never hardcode Windows drive letters (`C:/...`, `d:/...`), user home paths, or platform-specific path separators.
   - Always resolve `~/.gemini/antigravity` (and fallback candidates `antigravity-ide`, `antigravity-cli`) dynamically via `os.homedir()` and `process.env.ANTIGRAVITY_APP_DATA_DIR`.
   - Normalize `file://` URIs and filesystem paths via `normalizeWorkspacePath()`.
   - Keep `buildAgentHandoffRequest()` language-neutral so the agent writes `<HANDOFF_PROMPT>` in the same language the user uses in the conversation.
4. **Plugin Packaging & Distribution**:
   - Keep `"command": "node"` in the repository's `sidecars/agy-cockpit/sidecar.json`. Never commit a machine-specific Node binary path to git; `setup.cjs` resolves `process.execPath` on the target machine at install time.
   - Install `agy-cockpit` as a plugin under `~/.gemini/config/plugins/agy-cockpit/` (`plugin.json`, `README.md`, and `sidecars/agy-cockpit/`) so Antigravity auto-enables and auto-starts the sidecar by default (standalone sidecars in `~/.gemini/config/sidecars/` default to `SIDECAR_STATUS_STOPPED`).
5. **Performance Budgets**:
   - `server.cjs` `/api/status` refreshes must stay `< 5 ms` on warm cache using byte-offset incremental parsing (`parsedBytes`), `.git/HEAD` `mtimeMs` caching, and `~/.gemini/config/projects/` file `mtimeMs` caching.
6. **User-Facing Terminology & Compaction Tiers**:
   - Never expose raw `step_index` numbers in `ui.html`. Display **Compacts** (`CHECKPOINT` count), **Prompts** (`USER_INPUT` count), and **Total Tokens** (`input_tokens + cache_read_tokens + output_tokens`, plus aggregated child subagent tokens).
   - Never hardcode a fixed token limit for the compaction progress bar; always compute `observedCompactCeiling` dynamically as the median of `compactTriggerTokens`.
   - Compaction health tiers: **Fresh** (`0-2` compacts with `0` compacted prompts), **Warm** (`3-5` compacts, or `0-2` compacts once earlier prompts are compacted), **Heavy** (`6-9` compacts), **Polluted** (`10+` compacts).

## Unread / Blue Dot Debugging

- Before changing the active-chat claim (`claimActiveConversation`, `maybeTakeOverActiveClaim`, `isThisIframeActiveConv`), any automatic mark-seen path (`markConversationSeenInServer`, `viewedConvId`) or `lastViewMs` handling, read the notes above `ACTIVE_CONV_STORAGE_KEY` in `ui.html` and above `seenBaselineMs` in `server.cjs`. They record verified Antigravity behavior (one Cockpit iframe per opened chat, identical `last_user_view_time` on both chats of a switch) that every past regression ignored.
- Run `node tests/unread/run.cjs` before and after any change in that area (headless Chrome, Chromium or Edge; see `tests/unread/README.md`). `--ui <file>` runs it against another `ui.html` to reproduce a regression.
- Live tracing: create the empty file `<appDataDir>/scratch/agy-cockpit-trace.on` (usually `~/.gemini/antigravity/scratch/`), reproduce, then read `<appDataDir>/scratch/agy-cockpit-trace.jsonl`. It records per-poll server rows (`id,state,unread,lastStep,completed,userIn,view,seen,resp`), `.pbtxt` view stamps (`annotView`), every mark-seen with its caller, and UI claims and renders per iframe instance (`inst`). That directory is readable from the agent sandbox, unlike `annotations/` and `sidecar_data/`. Delete the flag file when done; the trace rotates at 20 MB.
