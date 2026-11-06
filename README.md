# AGY Cockpit (`agy-cockpit`)

[![mezura](screenshots/pill.svg)](https://github.com/subamanis/mezura)

Cross-platform **Antigravity Plugin & Sidecar UI Pane** for **Windows** and **Linux** (pure Node.js, zero external dependencies).

## Overview

As an Antigravity conversation grows, two things silently degrade the agent's effectiveness:
1. **Context Compaction (`CHECKPOINT` events)**: Each time a conversation hits the model's context window ceiling, Antigravity compacts older turns into a summary and retains only the last 10 user prompts verbatim. Repeated compactions gradually dilute earlier architectural constraints and debugging details.
2. **Git Repository Drift (`commits behind HEAD`)**: When commits are created in another terminal, branch, or conversation, an older chat's mental model of the repository falls out of sync with `HEAD`.

**AGY Cockpit** runs as a lightweight sidecar panel inside Antigravity (`Auxiliary Pane` and `Sidebar`). It monitors live context window usage, compaction tiers, cumulative token consumption (including spawned subagents), 5-hour and weekly model quota limits, and Git drift across all your projects, and provides a **Two-Step Smart Handoff** to seamlessly continue work in a fresh conversation.

<p align="center">
  <img src="screenshots/hero.png" alt="AGY Cockpit Sidecar Panel" width="380" />
</p>

## Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [1. Real-Time Context Pollution & Prompt Retention](#1-real-time-context-pollution--prompt-retention)
  - [2. Total Token Usage & Subagent Breakdown](#2-total-token-usage--subagent-breakdown)
  - [3. Git / Repository Drift Detection](#3-git--repository-drift-detection)
  - [4. Workspace Scoping, Live Activity Indicators, Search & Archiving](#4-workspace-scoping-live-activity-indicators-search--archiving)
  - [5. Two-Step Smart Handoff & Dynamic Model Selector](#5-two-step-smart-handoff--dynamic-model-selector)
  - [6. Antigravity Contract Verifier & Self-Diagnostics (`--doctor`)](#6-antigravity-contract-verifier--self-diagnostics---doctor)
- [Installation & Updates (Windows & Linux)](#installation--updates-windows--linux)
  - [Option A: Ask Your Antigravity AI Agent to Install It (Recommended)](#option-a-ask-your-antigravity-ai-agent-to-install-it-recommended)
  - [Option B: Manual CLI Installation](#option-b-manual-cli-installation)
  - [Updating When New Commits Are Pushed](#updating-when-new-commits-are-pushed)
  - [Uninstalling](#uninstalling)
  - [Opening the Panel in Antigravity](#opening-the-panel-in-antigravity)
- [Performance Architecture](#performance-architecture)
- [License](#license)

---

## Features

### 1. Real-Time Context Pollution & Prompt Retention
- **Human-Centric Metrics**: Tracks conversations strictly in terms of **Compacts** (`"type":"CHECKPOINT"`) and **User Prompts** (`"type":"USER_INPUT"`), never raw internal step indices.
- **Compaction Health Tiers**:
  - `0 to 2 compacts` (with `0` compacted prompts): **Fresh** (`#10b981`)
  - `3 to 5 compacts` (or `0 to 2` compacts once earlier prompts are compacted): **Warm** (`#eab308`)
  - `6 to 9 compacts`: **Heavy** (`#f97316`)
  - `10+ compacts`: **Polluted** (`#ef4444`)

<p align="center">
  <img src="screenshots/compaction-tiers.gif" alt="AGY Cockpit Compaction Tiers (Fresh to Polluted)" width="617" />
</p>

- **Prompt Retention Tracking**: Each Antigravity compaction retains the last 10 user prompts in full. When earlier prompts have been compacted, the active card displays `Prompts: 10 full · M compacted`.
- **Dynamic Context Window Ceiling (Zero Hardcoded Limits)**:
  - Reads `currentTokens = input_tokens + cache_read_tokens` from the latest `PLANNER_RESPONSE`.
  - Records `compactTriggerTokens` immediately preceding each `CHECKPOINT` and computes `observedCompactCeiling` as their rolling median.
  - Adapts automatically if Antigravity changes the context window size in future updates. If `currentTokens` exceeds a previously observed ceiling before a new compact triggers, the stale percentage is hidden (`observing new ceiling`) until the next compaction is observed.
- **Interactive Context Window Breakdown Modal**:
  - Clicking the **Context window** meter (`n / ~m (x%)`) on the active card opens an on-demand breakdown of the active context window (since the latest `CHECKPOINT` compaction, or from conversation start if uncompacted) with zero overhead on background polling:
    1. **Base vs Active Turn Growth**: Separates initial base context (`System & Rules / Initial Base` or `Base + Compaction Summary`, including cached system prefix tokens) from active turn token growth (`+X.Xk tok` across prompts and tool calls).
    2. **Loaded Skills**: Lists `SKILL.md` and skill files read in the active window (plus any skills read prior to the last compaction) with exact byte and token footprints.
    3. **Tool Activity by Category**: Groups active-window tool calls and outputs into `File Reads & Search`, `Terminal & Tasks`, `Code Edits & Writes`, and `Subagents & MCP` with call counts and byte/token volume bars.
    4. **Top 5 Heaviest Steps & Most Touched Files**: Ranks the 5 largest individual tool steps (`argBytes + outputBytes`, accounting for `<truncated N bytes>` markers in `O(1)`) and the most read/edited project files in the active window.

<p align="center">
  <img src="screenshots/context-breakdown.png" alt="AGY Cockpit Context Window Breakdown Modal" width="380" />
</p>

### 2. Total Token Usage & Subagent Breakdown
- Tracks cumulative token usage across every turn of a conversation:
  - **New Input Tokens** (`input_tokens`)
  - **Cached Read Tokens** (`cache_read_tokens`)
  - **Output Tokens** (`output_tokens`)
- Automatically links spawned subagent conversations (`invoke_subagent` / `sender=<uuid>`) to their parent chat, hiding subagents from the main conversation list while aggregating their token consumption on the parent conversation card.
- **Interactive Subagent Pill & Inline Breakdown (`+X.Xk · N sub ▾`)**: Clicking the subagent pill expands an inline list showing each spawned subagent's `↳` role/title, token consumption, and live status (`Done`, thinking dots `•••`, or amber `! Waiting permission` / `? Waiting answer`). Clicking any subagent row opens that subagent's conversation directly in Antigravity.
- **Live Subagent Status Propagation**: If a background subagent is actively thinking (`•••`) or waiting on tool permission (`!`) or a user answer (`?`), its status automatically propagates to the parent conversation card and project filter tab.
- **5-Hour & Weekly Model Usage Quota Ring**: Displays a live progress ring in the top bar matched to the active conversation's model family (`Anthropic Claude`, `Google Gemini`, `OpenAI`) or the highest usage bottleneck across families. Clicking the quota pill refreshes live usage and opens the **Model usage limits** modal with per-window usage bars (`5-hour`, `Daily`, `Weekly`, `Monthly`), remaining percentages, and live reset countdowns.

### 3. Git / Repository Drift Detection
- Detects the Git repository root associated with each conversation and compares the conversation's last activity timestamp against `HEAD` (excluding commits created inside that conversation).
- Displays `HEAD in sync` or `N commits behind HEAD`, and lists the missed commit hashes, subjects, and timestamps inside the expandable `History & Commits` drawer.

### 4. Workspace Scoping, Live Activity Indicators, Search & Archiving
- **Pinned Active Chat Card**: Pins the active conversation of the current workspace at the top with a live context meter and token breakdown. Clicking any conversation row in the list switches to that chat in Antigravity and pins it at the top.
- **Project-Scoped Filter Tabs & Live Thinking / Waiting / Unread Indicators**: Syncs with `~/.gemini/config/projects/` and `window.sidecar.getWorkspaceUris()` (`onWorkspaceChange`) to automatically scope the conversation list to the active project, with tabs (per-project tabs, `Unscoped / General`, `All (N)`, and `Archived (N)`) to switch across workspaces. Project tabs and conversation cards display animated thinking dots (`•••`) while an agent is streaming or executing tools, amber `!` (waiting for permission approval) or `?` (waiting for your answer to a question) badges when stalled on user input, and an unread blue dot (`●`) once a background reply completes.
- **Quick New Conversation (`+ New`)**: Spawn a new conversation directly from the filter bar inside any project workspace or as a general (`No Project (General)`) chat without leaving the panel.
- **Turn Previews (`You:` / `AI:`)**: Compact cards in `Other conversations` preview both your latest prompt (`You:`) and the model's latest response (`AI:`) on separate lines.
- **Conversation Pinning, Custom Renaming, Archiving & Deletion**: Right-click any project tab to start a **`+ New chat in "<Project>"`** or **Archive** the project, or use the bottom-right gear menu (`⚙`) on any conversation card to **Pin to top** / **Unpin from top**, **Rename...** (with **Reset Default**), **Copy ID**, **Archive** (restorable from `Archived (N)`), or permanently **Delete** (`DeleteCascadeTrajectory` with confirmation).
- **Instant Full-Text Search & Prompt History**: Filters conversations in real time across custom/auto titles, `USER_INPUT` prompts, and `Task Overview` checkpoint summaries. Expanding `History & Commits` shows missed Git commits, the latest compact overview, and user prompts clamped to 3 lines (`Show more` / `Show less`).

### 5. Two-Step Smart Handoff & Dynamic Model Selector
- **Step 1 (Optional Focus, AI Generation & Cancellation)**: Click **Smart Handoff** to open an editable focus box where you can optionally specify instructions for the next chat (such as focusing on a specific subtask or writing the handoff in another language), then click **Generate Handoff Prompt**. AGY Cockpit sends an `[AGY Cockpit Smart Handoff]` request to the conversation's agent instructing it to produce a self-contained `<HANDOFF_PROMPT>` without calling any tools. While generating, you can click **Cancel** at any time to abort the in-flight agent invocation (`CancelCascadeInvocation`).
- **Step 2 (Review, Edit, Select Model & Launch)**: As soon as the agent replies, the extracted `<HANDOFF_PROMPT>` is cached for that conversation and loaded directly into the plugin's editor so you can review or edit it before clicking **Start New Chat** or **Copy**. Re-opening **Smart Handoff** on a conversation that already generated a handoff opens directly in Step 2; clearing the text box (for example with `Ctrl+A` and `Backspace`) returns the drawer to Step 1 so you can enter new instructions and regenerate.
- **Dynamic Model & Thinking Tier Selector**: Discovers all models and thinking tiers available to your account from the local Antigravity Language Server, pre-selects the active conversation's current model and thinking tier by default, and launches the new conversation directly with the chosen model and thinking tier from Step 0 inside the same project and workspace.

<p align="center">
  <img src="screenshots/smart-handoff.png" alt="Smart Handoff Review & Dynamic Model / Thinking Tier Selector" width="535" />
</p>

### 6. Antigravity Contract Verifier & Self-Diagnostics (`--doctor`)
- **Automated AGY Update Protection**: `node setup.cjs --doctor` (and `node setup.cjs --doctor --json` for machine-readable output) verifies all 9 internal Antigravity contracts (`plugin_installation_sync`, `app_data_dirs`, `transcript_schema`, `annotations_pbtxt`, `projects_registry`, `language_server_binary`, `language_server_live_rpc`, `agentapi_cli`, and `sidecar_bridge_and_perf`), automatically probing the live running sidecar when reachable or falling back to offline CLI verification. The running sidecar also checks the 8 runtime contracts whenever it boots or when the `language_server` binary changes on disk after an Antigravity update.
- **Sticky Bottom Warning Drawer**: Stays completely invisible when all contracts pass (`ok`). If an Antigravity update renames or changes an RPC, CLI flag, or transcript schema field, a sticky floating bar appears at the bottom of the panel with a collapsible contract list, **Re-run Doctor**, and **Copy Fix Prompt** (ready to paste into any coding agent with exact failed contract IDs and `server.cjs` symbols).

---

## Installation & Updates (Windows & Linux)

Requires **Node.js 18+**. Works out of the box on both **Windows** and **Linux**.

### Option A: Ask Your Antigravity AI Agent to Install It (Recommended)

You can ask any Antigravity agent to install or update the plugin for you by pasting this prompt in chat:

```text
Install the AGY Cockpit plugin from this repository by running `node setup.cjs` (use BypassSandbox: true so it can write to ~/.gemini/config/plugins/agy-cockpit), verify with `node setup.cjs --check` and `node setup.cjs --doctor`, and give me the AGY Cockpit sidecar pill link.
```

#### Step-by-Step Instructions for AI Agents

If you are an AI agent asked to install or update **AGY Cockpit** on a user's system (Windows or Linux):
1. **Clone or locate the repository** (if not already open in the workspace).
2. **Run the installer outside the sandbox**:
   - Because [`setup.cjs`](./setup.cjs) installs files into `~/.gemini/config/plugins/agy-cockpit/` (outside the project workspace) and restarts the running sidecar process, execute `node setup.cjs` with `BypassSandbox: true` if standard sandbox mode blocks writes to `~/.gemini/config`.
3. **Verify the installation & runtime contracts**:
   - Run `node setup.cjs --check` and confirm the JSON output reports `"pluginInstalled": true`, `"readmeInstalled": true`, and `"sidecarInstalled": true`.
   - Run `node setup.cjs --doctor` and confirm all 9 contracts pass.
4. **Surface the sidecar pill & restart notice**:
   - Always include the clickable pill link in your response: `[AGY Cockpit](sidecar://agy-cockpit/agy-cockpit/ui.html)`
   - If this is a **first-time installation** (creating `~/.gemini/config/plugins/agy-cockpit` for the first time), inform the user to **restart or reload Antigravity** once so Antigravity discovers the new plugin directory.
   - If this is an **update** to an existing installation, no Antigravity restart is needed (`setup.cjs` automatically restarts `server.cjs` and the UI hot-reloads).

### Option B: Manual CLI Installation

From the repository root on **Windows** or **Linux**:

```bash
node setup.cjs
```

Verify installation status or run the full Antigravity contract verifier (`--doctor`):

```bash
node setup.cjs --check
node setup.cjs --doctor
```

### Updating When New Commits Are Pushed

- **In-Panel One-Click Update (`Update` button)**: AGY Cockpit checks GitHub (`subamanis/agy-cockpit`, branch `main`) in the background on startup and every hour. When a newer commit is available, an amber indicator dot appears next to the top-right **Update** button. Clicking **Update** pulls/downloads the latest release, validates `server.cjs`, updates `~/.gemini/config/plugins/agy-cockpit/`, and hot-reloads the server and panel automatically (or confirms `Already on latest version` when up to date).
- **Manual CLI Update**: Because Antigravity runs the plugin from `~/.gemini/config/plugins/agy-cockpit/`, pulling new commits manually in the git repository requires re-running `node setup.cjs` to sync the updated files and auto-restart the sidecar server (no Antigravity restart is required on updates; `server.cjs` restarts automatically and `ui.html` hot-reloads on the next poll):

```bash
git pull
node setup.cjs
node setup.cjs --doctor
```

Or ask your Antigravity AI agent:

```text
Update the AGY Cockpit plugin by running `git pull` and `node setup.cjs` (with BypassSandbox: true), then verify all contracts pass with `node setup.cjs --doctor`.
```

### Uninstalling

To stop the sidecar server and remove the plugin from `~/.gemini/config/plugins/agy-cockpit`:

```bash
node setup.cjs --uninstall
```

### Opening the Panel in Antigravity

Once installed, **AGY Cockpit** is automatically enabled and available in:
- The right **Auxiliary Pane** (`Extensions` / sidecar tab)
- The left **Sidebar** (`Plugins` section)
- Any Antigravity chat response via the pill link: `[AGY Cockpit](sidecar://agy-cockpit/agy-cockpit/ui.html)`

> [!IMPORTANT]
> **Portability Note (How to Share or Move Across Machines)**:
> Always install on a new Windows or Linux machine by cloning this repository and running `node setup.cjs`. Do **not** copy the installed `~/.gemini/config/plugins/agy-cockpit/` folder directly from one computer to another, because `setup.cjs` writes the host machine's resolved Node.js executable path (`process.execPath`, such as an `nvm` or `nvm4w` binary path) into the installed `sidecar.json` so GUI launches can always locate `node`.

---

## Performance Architecture

1. **Incremental Append-Only Transcript Indexing**:
   - [`server.cjs`](./sidecars/agy-cockpit/server.cjs) caches `mtimeMs`, `size`, `parsedBytes`, and `lastLineOffset` per conversation in memory and persists `index_cache.json`.
   - On subsequent polls, only the tail from `lastLineOffset` (`stat.size - lastLineOffset`) is read from disk so in-place rewrites of the active step are caught, and `"type":"GENERIC"` lines are skipped before `JSON.parse` (`< 1 ms` per status poll on warm cache).
2. **Directory & File Mtime Gating**:
   - Guards `annotations/*.pbtxt` and `~/.gemini/config/projects/*.json` behind directory and per-file `mtimeMs` checks so unchanged cold conversations and project manifests incur zero redundant disk I/O on `/api/status` polls.
3. **Git Reflog Tail Parser + `.git/HEAD` Mtime Guard**:
   - [`server.cjs`](./sidecars/agy-cockpit/server.cjs) inspects `.git/HEAD` and `.git/logs/HEAD` `mtimeMs` with a 1.5s TTL before reading Git state.
4. **Persistent Binary Symbol Cache & Tail-Only Diagnostics**:
   - `diagnostics_cache.json` persists verified `language_server` RPC and CLI symbols keyed by binary `mtimeMs` and size, and `readFileTailLines()` reads only the last 512 KB of sampled transcripts during `--doctor` checks.

---

## License

Licensed under the [MIT License](./LICENSE).

