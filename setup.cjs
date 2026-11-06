#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = __dirname;
const GEMINI_CONFIG_DIR = process.env.ANTIGRAVITY_CONFIG_DIR
  ? path.resolve(process.env.ANTIGRAVITY_CONFIG_DIR)
  : path.join(os.homedir(), '.gemini', 'config');

const PLUGIN_SRC_FILE = path.join(REPO_ROOT, 'plugin.json');
const README_SRC_FILE = path.join(REPO_ROOT, 'README.md');
const SIDECAR_SRC_DIR = path.join(REPO_ROOT, 'sidecars', 'agy-cockpit');

const PLUGIN_DEST_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins', 'agy-cockpit');
const SIDECAR_DEST_DIR = path.join(PLUGIN_DEST_DIR, 'sidecars', 'agy-cockpit');

function resolveNodeExecutable() {
  const execPath = process.execPath;
  if (execPath && /^node(\.exe)?$/i.test(path.basename(execPath)) && fs.existsSync(execPath)) {
    return execPath.replace(/\\/g, '/');
  }
  const existingManifest = path.join(SIDECAR_DEST_DIR, 'sidecar.json');
  if (fs.existsSync(existingManifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(existingManifest, 'utf-8'));
      if (parsed && typeof parsed.command === 'string' && parsed.command.trim()) {
        return parsed.command.trim().replace(/\\/g, '/');
      }
    } catch {}
  }
  return 'node';
}

function findServerInfoCandidates() {
  const appDirs = [];
  const envAppData = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envAppData) appDirs.push(path.resolve(envAppData));
  const geminiRoot = path.join(os.homedir(), '.gemini');
  for (const app of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    appDirs.push(path.join(geminiRoot, app));
  }

  const candidates = [];
  const envExecData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envExecData) {
    candidates.push(path.join(path.resolve(envExecData), 'server_info.json'));
  }
  for (const appDir of appDirs) {
    candidates.push(
      path.join(appDir, 'sidecar_data', 'agy-cockpit', 'agy-cockpit', 'data', 'server_info.json'),
      path.join(appDir, 'sidecar_data', 'agy-cockpit', 'data', 'server_info.json'),
      path.join(appDir, 'sidecar_data', 'agy-cockpit', 'server.json')
    );
  }
  return candidates;
}

function restartRunningSidecarServer() {
  const killedPids = new Set();
  const candidates = findServerInfoCandidates();

  for (const srvFile of candidates) {
    if (fs.existsSync(srvFile)) {
      try {
        const info = JSON.parse(fs.readFileSync(srvFile, 'utf-8'));
        const pid = Number(info && info.pid);
        if (pid > 0 && pid !== process.pid && !killedPids.has(pid)) {
          process.kill(pid, 'SIGTERM');
          killedPids.add(pid);
        }
      } catch {}
    }
  }

  if (process.platform === 'win32' && killedPids.size === 0) {
    try {
      const psScript =
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
        "Where-Object { $_.CommandLine -match 'agy-cockpit.*[\\\\/]server\\.cjs(\\s|$|\")' } | " +
        "Select-Object -ExpandProperty ProcessId";
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', psScript],
        { encoding: 'utf-8', timeout: 5000 }
      );
      for (const line of String(out || '').split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (pid > 0 && pid !== process.pid && !killedPids.has(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            killedPids.add(pid);
          } catch {}
        }
      }
    } catch {}
  } else if (process.platform !== 'win32' && killedPids.size === 0) {
    try {
      const out = execFileSync(
        'pgrep',
        ['-f', 'agy-cockpit.*/server\\.cjs'],
        { encoding: 'utf-8', timeout: 3000 }
      );
      for (const line of String(out || '').split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (pid > 0 && pid !== process.pid && !killedPids.has(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            killedPids.add(pid);
          } catch {}
        }
      }
    } catch {}
  }
}

function resolveRepoCommitSha(repoDir) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

function installAll() {
  const nodeBin = resolveNodeExecutable();

  fs.mkdirSync(SIDECAR_DEST_DIR, { recursive: true });
  fs.copyFileSync(PLUGIN_SRC_FILE, path.join(PLUGIN_DEST_DIR, 'plugin.json'));
  if (fs.existsSync(README_SRC_FILE)) {
    fs.copyFileSync(README_SRC_FILE, path.join(PLUGIN_DEST_DIR, 'README.md'));
  }

  const sidecarManifest = JSON.parse(
    fs.readFileSync(path.join(SIDECAR_SRC_DIR, 'sidecar.json'), 'utf-8')
  );
  sidecarManifest.command = nodeBin;
  fs.writeFileSync(
    path.join(SIDECAR_DEST_DIR, 'sidecar.json'),
    JSON.stringify(sidecarManifest, null, 2) + '\n',
    'utf-8'
  );

  for (const filename of ['server.cjs', 'ui.html']) {
    const src = path.join(SIDECAR_SRC_DIR, filename);
    const dest = path.join(SIDECAR_DEST_DIR, filename);
    fs.copyFileSync(src, dest);
  }

  fs.writeFileSync(
    path.join(PLUGIN_DEST_DIR, 'install_meta.json'),
    JSON.stringify({ installedCommit: resolveRepoCommitSha(REPO_ROOT), repoRoot: REPO_ROOT.replace(/\\/g, '/'), installedAtMs: Date.now() }, null, 2) + '\n',
    'utf-8'
  );

  restartRunningSidecarServer();

  console.log('[agy-cockpit] Installed successfully:');
  console.log('  Platform      :', `${process.platform} (${process.arch})`);
  console.log('  Node binary   :', nodeBin);
  console.log('  Plugin dir    :', PLUGIN_DEST_DIR);
  console.log('  Sidecar dir   :', SIDECAR_DEST_DIR);
  console.log('  Sidecar pill  : [AGY Cockpit](sidecar://agy-cockpit/agy-cockpit/ui.html)');
}

function uninstallAll() {
  restartRunningSidecarServer();
  if (fs.existsSync(PLUGIN_DEST_DIR)) {
    fs.rmSync(PLUGIN_DEST_DIR, { recursive: true, force: true });
  }
  console.log('[agy-cockpit] Uninstalled from', GEMINI_CONFIG_DIR);
}

function checkStatus() {
  const pluginOk = fs.existsSync(path.join(PLUGIN_DEST_DIR, 'plugin.json'));
  const readmeOk = fs.existsSync(path.join(PLUGIN_DEST_DIR, 'README.md'));
  const sidecarOk =
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'sidecar.json')) &&
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'server.cjs')) &&
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'ui.html'));

  console.log(JSON.stringify({
    platform: process.platform,
    configDir: GEMINI_CONFIG_DIR,
    pluginInstalled: pluginOk,
    readmeInstalled: readmeOk,
    sidecarInstalled: sidecarOk
  }, null, 2));

  if (!pluginOk || !readmeOk || !sidecarOk) {
    process.exitCode = 1;
  }
}

function filesMatchByteForByte(fileA, fileB) {
  try {
    if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return false;
    const bufA = fs.readFileSync(fileA);
    const bufB = fs.readFileSync(fileB);
    return bufA.length === bufB.length && Buffer.compare(bufA, bufB) === 0;
  } catch {
    return false;
  }
}

function checkPluginSyncContract() {
  const destPluginJson = path.join(PLUGIN_DEST_DIR, 'plugin.json');
  const destReadmeMd = path.join(PLUGIN_DEST_DIR, 'README.md');
  const destSidecarJson = path.join(SIDECAR_DEST_DIR, 'sidecar.json');
  const destServerCjs = path.join(SIDECAR_DEST_DIR, 'server.cjs');
  const destUiHtml = path.join(SIDECAR_DEST_DIR, 'ui.html');

  const installed =
    fs.existsSync(destPluginJson) &&
    (!fs.existsSync(README_SRC_FILE) || fs.existsSync(destReadmeMd)) &&
    fs.existsSync(destSidecarJson) &&
    fs.existsSync(destServerCjs) &&
    fs.existsSync(destUiHtml);

  if (!installed) {
    return {
      id: 'plugin_installation_sync',
      title: 'Plugin Installation & Repository Sync',
      status: 'fail',
      codeSymbol: 'setup.cjs:installAll',
      detail: `Plugin files missing in ${PLUGIN_DEST_DIR}`,
      fixHint: 'Run node setup.cjs to install AGY Cockpit into ~/.gemini/config/plugins/agy-cockpit/.'
    };
  }

  let commandOk = true;
  let sidecarJsonSyncOk = true;
  let configuredCommand = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(destSidecarJson, 'utf-8'));
    configuredCommand = (manifest && manifest.command) || '';
    if (configuredCommand && configuredCommand !== 'node' && !fs.existsSync(configuredCommand)) {
      commandOk = false;
    }
    const srcManifest = JSON.parse(fs.readFileSync(path.join(SIDECAR_SRC_DIR, 'sidecar.json'), 'utf-8'));
    const normDest = JSON.stringify({ ...manifest, command: 'node' });
    const normSrc = JSON.stringify({ ...srcManifest, command: 'node' });
    if (normDest !== normSrc) {
      sidecarJsonSyncOk = false;
    }
  } catch {
    commandOk = false;
  }

  if (!commandOk) {
    return {
      id: 'plugin_installation_sync',
      title: 'Plugin Installation & Repository Sync',
      status: 'fail',
      codeSymbol: 'setup.cjs:resolveNodeExecutable',
      detail: `Installed sidecar.json command points to missing Node binary: ${configuredCommand}`,
      fixHint: 'Run node setup.cjs to update sidecar.json with the current Node executable path.'
    };
  }

  const diffs = [];
  if (!filesMatchByteForByte(PLUGIN_SRC_FILE, destPluginJson)) diffs.push('plugin.json');
  if (fs.existsSync(README_SRC_FILE) && !filesMatchByteForByte(README_SRC_FILE, destReadmeMd)) diffs.push('README.md');
  if (!sidecarJsonSyncOk) diffs.push('sidecar.json');
  if (!filesMatchByteForByte(path.join(SIDECAR_SRC_DIR, 'server.cjs'), destServerCjs)) diffs.push('server.cjs');
  if (!filesMatchByteForByte(path.join(SIDECAR_SRC_DIR, 'ui.html'), destUiHtml)) diffs.push('ui.html');

  if (diffs.length > 0) {
    return {
      id: 'plugin_installation_sync',
      title: 'Plugin Installation & Repository Sync',
      status: 'warn',
      codeSymbol: 'setup.cjs:installAll',
      detail: `Installed plugin files differ from repository (${diffs.join(', ')} out of sync).`,
      fixHint: 'Run node setup.cjs to deploy the latest repository files to ~/.gemini/config/plugins/agy-cockpit/.'
    };
  }

  return {
    id: 'plugin_installation_sync',
    title: 'Plugin Installation & Repository Sync',
    status: 'pass',
    codeSymbol: 'setup.cjs:installAll',
    detail: `Installed and byte-identical with repo (node=${configuredCommand || 'node'}).`,
    fixHint: ''
  };
}

function httpGetJson(host, port, urlPath, token, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const headers = { Accept: 'application/json' };
    if (token) headers['X-Sidecar-Token'] = token;
    const req = http.request(
      {
        hostname: host || '127.0.0.1',
        port: Number(port),
        path: urlPath,
        method: 'GET',
        headers,
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8').trim();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ error: `HTTP ${res.statusCode}`, statusCode: res.statusCode });
            return;
          }
          try {
            resolve({ data: JSON.parse(raw), statusCode: res.statusCode });
          } catch {
            resolve({ error: 'Invalid JSON response', statusCode: res.statusCode });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out' });
    });
    req.on('error', (err) => {
      resolve({ error: err.message });
    });
    req.end();
  });
}

async function probeLiveSidecarServer(simulate = '') {
  const candidates = findServerInfoCandidates();
  for (const srvFile of candidates) {
    if (!fs.existsSync(srvFile)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(srvFile, 'utf-8'));
      const port = Number(info && info.port);
      const host = (info && info.host) || '127.0.0.1';
      const token = (info && info.token) || '';
      const pid = Number(info && info.pid) || 0;
      if (!port) continue;

      const qs = new URLSearchParams({ refresh: '1' });
      if (simulate) qs.set('simulate', simulate);
      const diagRes = await httpGetJson(host, port, `/api/diagnostics?${qs.toString()}`, token, 8000);
      if (diagRes && diagRes.data && Array.isArray(diagRes.data.contracts)) {
        return {
          reachable: true,
          pid,
          host,
          port,
          serverInfoPath: srvFile,
          report: diagRes.data
        };
      }
    } catch {}
  }
  return { reachable: false };
}

async function runDoctor(args = []) {
  const asJson = args.includes('--json');
  const simArg = args.find((a) => a.startsWith('--simulate='));
  const simulate = simArg ? simArg.split('=')[1].trim().toLowerCase() : '';

  const syncContract = checkPluginSyncContract();
  const liveProbe = await probeLiveSidecarServer(simulate);

  let serverReport;
  let executionMode = 'live-sidecar';
  if (liveProbe.reachable && liveProbe.report) {
    serverReport = liveProbe.report;
  } else {
    executionMode = 'offline-local';
    const { AgyCockpitServer } = require('./sidecars/agy-cockpit/server.cjs');
    const localSrv = new AgyCockpitServer();
    localSrv.refreshProjectsRegistry(true);
    localSrv.refreshIndex({ force: true });
    localSrv.refreshIndex({ force: false });
    serverReport = await localSrv.runDiagnostics({
      refresh: true,
      offlineMode: true,
      simulate
    });
  }

  const allContracts = [syncContract, ...(serverReport.contracts || [])];
  const failCount = allContracts.filter((c) => c.status === 'fail').length;
  const warnCount = allContracts.filter((c) => c.status === 'warn').length;
  const passCount = allContracts.filter((c) => c.status === 'pass').length;
  const overallStatus = failCount > 0 ? 'fail' : (warnCount > 0 ? 'warn' : 'ok');

  const fullReport = {
    status: overallStatus,
    executionMode,
    sidecarServer: liveProbe.reachable
      ? { reachable: true, pid: liveProbe.pid, host: liveProbe.host, port: liveProbe.port }
      : { reachable: false },
    checkedAtIso: serverReport.checkedAtIso || new Date().toISOString(),
    durationMs: serverReport.durationMs || 0,
    agyBinary: serverReport.agyBinary || null,
    summary: {
      total: allContracts.length,
      pass: passCount,
      warn: warnCount,
      fail: failCount
    },
    contracts: allContracts
  };

  if (asJson) {
    console.log(JSON.stringify(fullReport, null, 2));
  } else {
    const statusLabel = overallStatus === 'ok'
      ? 'HEALTHY (ALL CONTRACTS PASSED)'
      : (overallStatus === 'warn' ? 'DEGRADED (WARNINGS DETECTED)' : 'BROKEN (CONTRACT FAILURES DETECTED)');
    console.log(`[agy-cockpit doctor] Status: ${statusLabel}`);
    console.log(
      `  Mode          : ${
        liveProbe.reachable
          ? `live sidecar (PID ${liveProbe.pid} on ${liveProbe.host}:${liveProbe.port})`
          : 'offline CLI (sidecar not currently reachable via server_info.json)'
      }`
    );
    if (fullReport.agyBinary && fullReport.agyBinary.path) {
      console.log(`  AGY Binary    : ${fullReport.agyBinary.path}`);
    }
    console.log(`  Contracts     : ${passCount} passed, ${warnCount} warnings, ${failCount} failed (in ${fullReport.durationMs} ms)`);
    console.log('');
    for (const c of allContracts) {
      const tag = c.status === 'pass' ? '[PASS]' : (c.status === 'warn' ? '[WARN]' : '[FAIL]');
      console.log(`${tag} ${c.id}: ${c.title}`);
      console.log(`       Target : ${c.codeSymbol}`);
      console.log(`       Detail : ${c.detail}`);
      if (c.fixHint && c.status !== 'pass') {
        console.log(`       Fix    : ${c.fixHint}`);
      }
    }
  }

  if (failCount > 0) {
    process.exitCode = 1;
  }
  return fullReport;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    uninstallAll();
  } else if (args.includes('--check')) {
    checkStatus();
  } else if (args.includes('--doctor')) {
    runDoctor(args).catch((err) => {
      console.error('[agy-cockpit doctor] Fatal error:', err);
      process.exit(1);
    });
  } else {
    installAll();
  }
}

module.exports = { installAll, uninstallAll, checkStatus, runDoctor };
