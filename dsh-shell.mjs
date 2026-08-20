#!/usr/bin/env node
// ============================================================================
// dsh-shell.mjs —— DeepSeek Harness 纯壳启动器（零依赖，Node >= 20）
// 设计原则（纯壳）：
//   * 不改 dsh 内部任何东西；只做：启停、状态、更新（走官方 npm）、日志
//   * UI 只在浏览器/独立窗口显示，壳本体是零依赖 Node 单文件
//   * 更新 = 官方 npm install @deepseek-ai/dsh@latest，多镜像轮换兜底
//   * 全新设备：未安装 dsh 时，面板「一键安装 / 更新」自动装到 installRoot
//   * 外部 dsh 进程（非本壳启动）默认锁定，避免误杀正在运行的服务
// ============================================================================
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  statSync, renameSync, unlinkSync, copyFileSync, rmSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 配置 ----
const DEFAULTS = {
  shellPort: 3081,
  dshPort: 3080,
  dshProxyPort: 3089,   // 已废弃（反代被 dsh 安全层拒绝），仅保留兼容
  dshPackage: '@deepseek-ai/dsh',
  installRoot: '%LOCALAPPDATA%\dsh-cli',
  nodeMinMajor: 20,
  autoOpenBrowser: true,
  autoCheckUpdate: true,    // 启动后后台快速检查一次最新版本（有新版才提示）
  autoOpenDshWindow: true,  // dsh 启动就绪后，自动拉起"DSH 显示器"独立窗口
  windowMode: 'webview2',  // 'webview2' = WebView2 原生窗口（推荐：图标/任务栏分组可控）；'edge-app' = Edge 独立窗口（兜底）；'browser' = 默认浏览器
  mirrors: [
    'https://registry.npmmirror.com',
    'https://mirrors.cloud.tencent.com/npm/',
    'https://repo.huaweicloud.com/repository/npm/',
    'https://registry.npmjs.org'
  ]
};

function expandEnv(s) {
  return String(s).replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? ('%' + k + '%'));
}

function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  let user = {};
  if (existsSync(cfgPath)) {
    try { user = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* 配置损坏时用默认 */ }
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.installRoot = expandEnv(cfg.installRoot);
  return cfg;
}

const cfg = loadConfig();
const SHELL_VERSION = '1.0.0'; // 壳版本号（界面/日志显示，便于更新对齐）
// dsh 启动目录：仅作中性默认（工作区由 dsh 自身持久化管理，在 DSH UI 中切换，不向用户暴露）
const START_CWD = os.homedir();
const dataDir = path.join(__dirname, 'data');
// 稳定状态目录：归属凭据（pid 文件）放这里，清理 data/ 不影响"dsh 是本壳启动的"判断
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-shell');
mkdirSync(STATE_DIR, { recursive: true });
// 壳自身 PID 标记（记录"pid 端口"），用于下次启动识别残留的假死壳
const shellPidFile = path.join(STATE_DIR, 'shell.pid');
function writeShellPid() { try { writeFileSync(shellPidFile, process.pid + ' ' + cfg.shellPort); } catch {} }
function clearShellPid() { try { if (existsSync(shellPidFile)) unlinkSync(shellPidFile); } catch {} }
async function cleanupStaleShell() {
  try {
    if (!existsSync(shellPidFile)) return;
    const parts = readFileSync(shellPidFile, 'utf8').trim().split(/\s+/);
    const pid = Number(parts[0]), port = Number(parts[1]);
    if (!pid || port !== cfg.shellPort) { clearShellPid(); return; }
    const holder = await findPidOnPort(cfg.shellPort);
    if (holder === pid) {
      shellLog('发现残留的假死壳 PID ' + pid + '（shell.pid 标记），自动清理...');
      // 注意：不能带 /T —— dsh 是 detached 子进程，但父子链仍挂在壳下，/T 会连带杀掉
      // 应独立存活的 dsh（实测导致 3080 意外关闭）。只杀壳本身。
      await runCmd('taskkill', ['/PID', String(pid), '/F'], { timeoutMs: 8000 });
      await new Promise(r => setTimeout(r, 1200));
    }
    clearShellPid();
  } catch {}
}
const pidFile = path.join(STATE_DIR, 'dsh.pid');
const dshLogFile = path.join(dataDir, 'dsh.log');
const shellLogFile = path.join(dataDir, 'shell.log');
mkdirSync(dataDir, { recursive: true });

function shellLog(text) {
  try { appendFileSync(shellLogFile, '[' + new Date().toISOString() + '] ' + text + '\n'); } catch {}
}

// ---------------------------------------------------------------- 状态 ----
const state = {
  running: false,      // dsh 端口是否在监听
  owned: false,        // 是否由本壳启动/接管（可安全停止）
  starting: false,
  stopping: false,
  busy: false,         // 安装/更新等长任务
  checking: false,
  pid: null,
  localVersion: null,
  latestVersion: null,
  lastCheckAt: null
};
let child = null;               // 本壳启动的 dsh 子进程
const ring = [];                // 日志环形缓冲
const sseClients = new Set();
const RING_MAX = 2000;
let noClientTimer = null;
// 面板（SSE 连接）全部关闭后，120 秒内无人重新打开则壳自动退出（dsh 是独立进程，不受影响）
function scheduleExitIfNoPanel() {
  if (sseClients.size > 0) { if (noClientTimer) { clearTimeout(noClientTimer); noClientTimer = null; } return; }
  if (noClientTimer) return;
  noClientTimer = setTimeout(() => {
    shellLog('面板已关闭超过 120 秒，壳自动退出（dsh 服务不受影响）');
    clearShellPid();
    process.exit(0);
  }, 120000);
}

function pushLog(level, text) {
  const entry = { t: Date.now(), level, text };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    try {
      if (statSync(dshLogFile).size > 5 * 1024 * 1024) { try { renameSync(dshLogFile, dshLogFile + '.old'); } catch {} }
    } catch {}
    appendFileSync(dshLogFile,
      '[' + new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false }) + '] [' + level + '] ' + text + '\n');
  } catch {}
  broadcast('log', entry);
}

function broadcast(event, payload) {
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const c of sseClients) { try { c.write(frame); } catch {} }
}

// dsh CLI 候选位置（按优先级）：
//   1) 稳定安装根（壳管理，默认 %LOCALAPPDATA%\dsh-cli）
//   2) 旧式 profiles 安装（与旧启动器一致，位于 DSH_HOME）
//   3) profiles/web 安装（旧 update 脚本目标）
//   4) npx hoisted 检出目录兜底（最后才认）
function candidateCliPaths() {
  const home = process.env.USERPROFILE || '';
  const tmp = process.env.TEMP || '';
  return [
    path.join(cfg.installRoot, 'node_modules', cfg.dshPackage, 'lib', 'bin.js'),
    path.join(home, '.dsh', 'profiles', 'node_modules', cfg.dshPackage, 'lib', 'bin.js'),
    path.join(home, '.dsh', 'profiles', 'web', 'node_modules', cfg.dshPackage, 'lib', 'bin.js'),
    path.join(tmp, 'dsh-hoisted', 'node_modules', cfg.dshPackage, 'lib', 'bin.js')
  ];
}
let foundCli = null;
function findDshCli() {
  if (foundCli && existsSync(foundCli)) return foundCli;
  for (const p of candidateCliPaths()) {
    if (existsSync(p)) { foundCli = p; return p; }
  }
  return null;
}
function cliInstalled() { return !!findDshCli(); }

function localVersion() {
  const cli = findDshCli();
  if (!cli) return null;
  try {
    const pkg = path.join(path.dirname(cli), '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
  } catch { return null; }
}

function nodeVersionOk() {
  return Number(String(process.versions.node).split('.')[0]) >= cfg.nodeMinMajor;
}

function statusJson() {
  return {
    running: state.running, owned: state.owned, starting: state.starting,
    stopping: state.stopping, busy: state.busy, checking: state.checking,
    pid: state.pid, localVersion: state.localVersion, latestVersion: state.latestVersion,
    lastCheckAt: state.lastCheckAt, installed: cliInstalled(), cliPath: findDshCli(),
    version: SHELL_VERSION,
    dshPort: cfg.dshPort, installRoot: cfg.installRoot,
    windowMode: cfg.windowMode, appBrowser: !!findAppBrowser(),
    shellPort: cfg.shellPort,
    nodeOk: nodeVersionOk()
  };
}

// ---------------------------------------------------------------- 工具 ----
function runCmd(file, args, { timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    // Windows 上 npm 是 npm.cmd，execFile 无法直接执行 .cmd（ENOENT）——统一走 cmd /c npm ...
    if (String(file).toLowerCase() === 'npm') {
      file = process.env.ComSpec || 'cmd.exe';
      args = ['/c', 'npm', ...args];
    }
    execFile(file, args, {
      windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? -1) : 0,
        out: String(stdout ?? ''),
        err: String(stderr ?? ''),
        timedOut: !!err?.killed
      });
    });
  });
}

function checkPort(port, host = '127.0.0.1') {
  return new Promise(res => {
    const s = net.connect({ port, host });
    const done = ok => { try { s.destroy(); } catch {} res(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1200, () => done(false));
  });
}

async function findPidOnPort(port) {
  const r = await runCmd('netstat', ['-ano'], { timeoutMs: 8000 });
  if (!r.ok) return null;
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+([^\s]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[2]) === port) return Number(m[3]);
  }
  return null;
}

function readPidFile() {
  try { return Number(readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; }
}
function writePidFile(pid) {
  try { writeFileSync(pidFile, String(pid)); } catch {}
}

function openBrowser(url) {
  execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

// 独立应用窗口：Edge/Chrome 的 --app 模式（无标签页、地址栏），Windows 自带
const APP_BROWSER_PATHS = [
  process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
];
function findAppBrowser() {
  for (const p of APP_BROWSER_PATHS) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// ---- DSH 独立图标 + 任务栏分离 ----
const SHELL_ICO = path.join(__dirname, 'dsh-shell.ico');
// WebView2 原生显示器宿主（display/ 目录随附官方 WebView2 SDK DLL）
const DISPLAY_EXE = path.join(__dirname, 'display', 'dsh-display.exe');

function dshShortcutPath() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'dsh-shell', 'DeepSeek Harness Shell.lnk');
}
async function ensureDshShortcut() {
  const lnk = dshShortcutPath();
  // 每次都重建（幂等，~1 秒）：修复旧版创建时 AUMID 属性缺失/残留的快捷方式
  try { if (existsSync(lnk)) unlinkSync(lnk); } catch {}
  const ps1 = path.join(__dirname, 'setup-shortcut.ps1');
  if (!existsSync(SHELL_ICO) || !existsSync(ps1)) return false;
  let target, args, aumid;
  if (cfg.windowMode === 'webview2' && existsSync(DISPLAY_EXE)) {
    // WebView2 模式：快捷方式直接指向显示器宿主 exe
    //  - 图标 = exe 内嵌图标（dsh-shell.ico），任务栏分组 = exe 自设的 AUMID，均无需快捷方式属性
    //  - 不再拉起 Edge，旧 edge-profile-dsh 也不会被重建
    target = DISPLAY_EXE;
    args = 'http://127.0.0.1:' + cfg.dshPort;
    aumid = 'DeepSeekHarness.Shell.Display';
  } else {
    const exe = findAppBrowser();
    if (!exe) return false;
    // 关键：参数里不加 --app-user-model-id —— 从快捷方式启动的窗口会继承快捷方式的
    // 图标和身份（Windows 标准行为），加了该参数反而让任务栏按自定义 AUMID 找快捷方式，
    // 而属性写入在本机不落盘 -> 找不到 -> 回退 Edge 图标
    target = exe;
    args = '--app=http://127.0.0.1:' + cfg.dshPort
      + ' --user-data-dir=' + path.join(dataDir, 'edge-profile-dsh')
      + ' --no-first-run --no-default-browser-check --disable-sync';
    aumid = 'dsh-shell.DSH.0';
  }
  const r = await runCmd('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-LnkPath', lnk, '-Target', target, '-Arguments', args, '-Icon', SHELL_ICO, '-Aumid', aumid], { timeoutMs: 30000 });
  return existsSync(lnk);
}

function openAppWindow(url, appId, profileName) {
  const exe = findAppBrowser();
  if (!exe) { openBrowser(url); return; }
  // 每个窗口用独立 user-data-dir（独立 Edge 实例）：
  //   - 不污染正常浏览器
  //   - 面板/DSH 显示器互不牵连（关一个窗口不影响另一个）
  const profileDir = path.join(dataDir, profileName || 'edge-profile-panel');
  // --app-user-model-id：独立 AppUserModelID -> 任务栏/Alt-Tab 中与 Edge 分离
  // 窗口图标来自页面 favicon（dsh UI 自带官方 favicon.svg）
  const args = [
    '--app=' + url,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',                  // 禁用同步，消除"同步浏览数据"引导提示
    '--disk-cache-size=1048576',       // 磁盘缓存上限 1MB，避免 profile 膨胀
    '--disable-component-update'       // 禁止 Edge 组件更新（hyph/钱包/广告列表等，每个几十 MB）
  ];
  if (appId) args.push('--app-user-model-id=' + appId);
  spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
function openPanel() {
  const url = 'http://127.0.0.1:' + cfg.shellPort;
  // 面板始终用独立窗口（Edge App，profile 已限体积）；仅 browser 模式走浏览器
  if (cfg.windowMode === 'browser') openBrowser(url);
  else openAppWindow(url, 'dsh-shell.Panel.0', 'edge-profile-panel');
}
// WebView2 原生显示器：display/dsh-display.exe（独立进程，关闭窗口不影响 dsh）
// 窗口图标/任务栏分组由 exe 内嵌图标 + SetCurrentProcessExplicitAppUserModelID 控制；
// 用户数据目录默认 %LOCALAPPDATA%\dsh-shell\webview2-display（exe 内部默认值）
function openDisplayHost(url) {
  if (!existsSync(DISPLAY_EXE)) {
    pushLog('warn', '显示器宿主缺失（display\\dsh-display.exe），回退 Edge 窗口');
    openAppWindow(url, 'dsh-shell.DSH.0', 'edge-profile-dsh');
    return;
  }
  try {
    spawn(DISPLAY_EXE, [url], { detached: true, stdio: 'ignore' }).unref();
    pushLog('info', '显示器宿主已拉起: ' + url);
  } catch (e) {
    pushLog('error', '显示器启动失败: ' + e.message + '，回退 Edge 窗口');
    openAppWindow(url, 'dsh-shell.DSH.0', 'edge-profile-dsh');
  }
}
function openDshUi() {
  // 直连 3080（反代会破坏 dsh 插件加载）
  const url = 'http://127.0.0.1:' + cfg.dshPort;
  pushLog('info', '拉起 DSH 显示器: ' + url);
  if (cfg.windowMode === 'webview2') { openDisplayHost(url); return; }
  if (cfg.windowMode !== 'edge-app') { openBrowser(url); return; }
  // 优先通过快捷方式启动：任务栏使用快捷方式的独立图标（dsh-shell.ico）+ AUMID 与 Edge 分组分离
  // 注意：不能用 powershell 内联 Start-Process（引号会被 Node 转义破坏），用 explorer 打开 .lnk
  const lnk = dshShortcutPath();
  if (existsSync(lnk)) {
    spawn('explorer.exe', [lnk], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    openAppWindow(url, 'dsh-shell.DSH.0', 'edge-profile-dsh');
  }
}

// ---------------------------------------------------------------- 启停 ----
async function startDsh() {
  if (state.running) return { ok: false, msg: cfg.dshPort + ' 端口已在运行' };
  if (state.starting) return { ok: false, msg: '正在启动中' };
  if (state.busy) return { ok: false, msg: '安装/更新进行中，请稍候' };
  if (await checkPort(cfg.dshPort)) return { ok: false, msg: cfg.dshPort + ' 端口已被占用（检测到服务在运行），请先停止现有实例' };
  const cli = findDshCli();
  if (!cli) return { ok: false, msg: 'dsh 未安装：请先点击「一键安装 / 更新」' };
  if (!nodeVersionOk()) return { ok: false, msg: 'Node 版本过低（需要 >= ' + cfg.nodeMinMajor + '）' };
  state.starting = true;
  broadcast('status', statusJson());
  pushLog('info', '启动 dsh（' + cli + '）...');
  // 直接 spawn node（参数数组，Node 负责引号转义）：
  //   不能用 cmd /c 拼命令字符串——cmd 会把路径两侧的引号原样传给 node（MODULE_NOT_FOUND）
  //   stdio: 'ignore'：不向 dsh 传任何句柄 -> 根治"dsh 继承壳监听句柄"导致的幽灵端口
  //   （代价：dsh 自身 stdout/stderr 不再写入 dsh.log；解耦承诺不受影响）
  child = spawn(process.execPath, [cli, 'web'], {
    cwd: START_CWD,
    env: process.env,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  writePidFile(child.pid ?? 0);
  pushLog('info', 'dsh 进程已拉起 PID=' + child.pid);
  child.on('error', e => {
    pushLog('error', 'dsh 启动失败: ' + e.message);
    state.starting = false; state.running = false; state.owned = false; state.pid = null;
    child = null; writePidFile(0);
    broadcast('status', statusJson());
  });
  child.on('exit', (code, sig) => {
    if (code === 0) pushLog('info', 'dsh 进程正常退出');
    else pushLog('warn', 'dsh 进程退出 code=' + code + (sig ? ' signal=' + sig : ''));
    state.starting = false; state.running = false; state.owned = false; state.pid = null;
    child = null; writePidFile(0);
    broadcast('status', statusJson());
  });
  // 等待端口就绪（最多 90s），且要求"我们的进程仍存活"（防止把外部实例误认成自己启动的）
  const deadline = Date.now() + 90000;
  let up = false;
  while (Date.now() < deadline) {
    if (child === null || child.exitCode !== null) break; // 我们的进程已退出（如端口被占 EADDRINUSE）
    if (await checkPort(cfg.dshPort)) { up = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  const ourAlive = child !== null && child.exitCode === null;
  const portPid = up ? await findPidOnPort(cfg.dshPort) : null;
  state.starting = false;
  if (up && ourAlive) {
    state.running = true; state.owned = true;
    state.pid = portPid ?? child?.pid ?? null;
    writePidFile(state.pid ?? 0); // 记录真实监听 PID（cmd 中间进程的 pid 不是 3080 监听者）
    pushLog('info', 'dsh 已就绪: http://127.0.0.1:' + cfg.dshPort);
    // 壳负责拉起"DSH 显示器"：全尺寸独立窗口显示 dsh UI（关闭窗口不影响 dsh）
    if (cfg.autoOpenDshWindow) setTimeout(() => openDshUi(), 800);
  } else if (up && !ourAlive) {
    // 端口上有服务，但不是我们启动的（我们的进程已退出）——极可能是外部实例占用导致 EADDRINUSE
    state.running = true; state.owned = false; state.pid = portPid;
    pushLog('error', '启动失败：dsh 进程已退出（code=' + (child?.exitCode ?? '?') + '），端口 ' + cfg.dshPort + ' 已有其他实例在运行（PID ' + (portPid ?? '?') + '）。请先停止现有实例。');
  } else {
    state.running = false; state.owned = false;
    pushLog('error', 'dsh 启动失败：进程已退出（code=' + (child?.exitCode ?? '?') + '）。请查看日志（dsh.log）中的具体原因。');
  }
  broadcast('status', statusJson());
  return (up && ourAlive) ? { ok: true, msg: '已启动' } : { ok: false, msg: state.running ? '启动失败：端口被其他进程占用' : '启动失败：进程已退出' };
}

async function stopDsh() {
  if (!state.running) return { ok: true, msg: '未在运行' };
  if (!state.owned) return { ok: false, msg: '外部进程已锁定，不提供停止（避免误杀）' };
  state.stopping = true;
  broadcast('status', statusJson());
  pushLog('info', '停止 dsh（PID=' + state.pid + '）...');
  const pid = state.pid;
  if (child) { try { child.kill(); } catch {} }
  else {
    // 本壳重启后接管自有旧实例（child 已丢失）：直接连树杀
    // （这是"用户主动停止 dsh"的路径，连树杀是预期行为，保留 /T）
    await runCmd('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 });
  }
  const waitFree = async (ms) => {
    const d = Date.now() + ms;
    while (Date.now() < d && await checkPort(cfg.dshPort)) await new Promise(r => setTimeout(r, 500));
  };
  await waitFree(8000);
  if (await checkPort(cfg.dshPort)) {
    pushLog('info', '优雅退出未生效，强制结束进程树 PID=' + pid + '...');
    await runCmd('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 });
    await waitFree(8000);
  }
  state.stopping = false;
  const still = await checkPort(cfg.dshPort);
  state.running = still;
  if (!still) {
    state.pid = null; state.owned = false; writePidFile(0);
    pushLog('info', 'dsh 已停止');
  } else {
    pushLog('error', '端口 ' + cfg.dshPort + ' 仍被占用（可能被其他程序占用）');
  }
  broadcast('status', statusJson());
  return still ? { ok: false, msg: '停止失败：端口仍被占用' } : { ok: true, msg: '已停止' };
}

async function restartDsh() {
  if (state.running && state.owned) {
    const s = await stopDsh();
    if (!s.ok) return s;
  }
  if (state.running && !state.owned) return { ok: false, msg: '外部进程已锁定，不提供重启' };
  return startDsh();
}

// ---------------------------------------------------------------- 更新 ----
async function fetchLatestFrom(mirror) {
  const base = String(mirror).replace(/\/+$/, '');
  const url = base + '/' + cfg.dshPackage.replace('/', '%2F') + '/latest';
  // Promise.race 硬超时：DNS/连接挂死也保证按时返回（AbortController 无法中断 DNS 查询）
  const timeout = new Promise(res => setTimeout(() => res(null), 13000));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await Promise.race([
      fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'dsh-shell' } }).catch(() => null),
      timeout
    ]);
    clearTimeout(timer);
    if (!res) return { ok: false, detail: '连接超时(13s)' };
    if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
    const j = await res.json();
    return j && j.version ? { ok: true, version: String(j.version) } : { ok: false, detail: '响应缺少 version 字段' };
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? '连接超时(10s)' : (e.cause?.code || e.message || String(e)) };
  }
}

async function checkUpdate(quick = false) {
  if (state.checking || state.busy) return { ok: false, msg: '已有任务进行中' };
  state.checking = true;
  state.localVersion = localVersion();
  broadcast('status', statusJson());
  if (quick) pushLog('info', '启动时自动检查更新...');
  let latest = null, lastDetail = '';
  for (const m of cfg.mirrors) {
    if (!quick) pushLog('info', '查询最新版本（源: ' + m + '）...');
    const viaFetch = await fetchLatestFrom(m);
    if (viaFetch.ok) { latest = viaFetch.version; if (!quick) pushLog('info', '官方最新版本: ' + latest); break; }
    lastDetail = viaFetch.detail;
    if (quick) continue; // 快速模式只走 fetch，不做 npm 兜底
    // 备用：npm view
    const r = await runCmd('npm', ['view', cfg.dshPackage, 'version', '--registry=' + m], { timeoutMs: 15000 });
    const v = r.out.trim();
    if (r.ok && v && /^\d/.test(v)) { latest = v; pushLog('info', '官方最新版本: ' + v); break; }
    if (r.timedOut) lastDetail = 'npm view 超时(15s)';
    else if (r.err.includes('ENOENT')) lastDetail = '未找到 npm';
    else if (r.err.trim()) lastDetail = r.err.trim().split(/\r?\n/).slice(-1)[0];
    pushLog('warn', '源不可用: ' + m + '（' + lastDetail + '）');
  }
  if (!latest) {
    if (quick) pushLog('info', '启动检查未获取到最新版本（' + lastDetail + '），需要时可手动「检查更新」。');
    else pushLog('error', '所有镜像都无法查询版本（最后原因: ' + lastDetail + '）。请检查网络/代理，或稍后重试。');
  } else if (quick) {
    if (!state.localVersion || state.localVersion !== latest) {
      pushLog('info', '发现新版本: ' + latest + (state.localVersion ? '（当前 ' + state.localVersion + '）' : '（本机未安装）'));
    } else {
      pushLog('info', '已是最新版本: ' + latest);
    }
  }
  state.latestVersion = latest;
  state.lastCheckAt = Date.now();
  state.checking = false;
  broadcast('status', statusJson());
  return { ok: !!latest, latest, detail: lastDetail };
}

async function updateDsh() {
  if (state.busy || state.checking) return { ok: false, msg: '已有任务进行中' };
  // 直接用已知版本信息判断（壳启动时已读取最新版；前提是两者读取正确）：
  //   一致 → 已是最新，无需更新；否则（未安装 / 有新版 / 最新版未知）→ 直接安装/更新
  if (state.localVersion && state.latestVersion && state.localVersion === state.latestVersion) {
    pushLog('info', '已是最新版本 ' + state.latestVersion + '，无需更新');
    return { ok: false, msg: '已是最新版本 ' + state.latestVersion + '，无需更新' };
  }
  // 立即进入 busy 并给反馈（安装过程可能耗时较长）
  state.busy = true;
  broadcast('status', statusJson());
  pushLog('info', state.localVersion
    ? ('开始更新：当前 ' + state.localVersion + '，最新 ' + (state.latestVersion || '未知') + '...')
    : '开始安装 dsh（本机未安装）...');
  try {
    // 前置检查（先于停服务）：Node 版本 + npm 可用——检查失败时 dsh 保持运行，不会丢服务
    if (!nodeVersionOk()) { pushLog('error', 'Node 版本过低，无法安装。'); return { ok: false, msg: 'Node 版本过低，无法安装' }; }
    const npmv = await runCmd('npm', ['--version'], { timeoutMs: 8000 });
    if (!npmv.ok) { pushLog('error', '未找到 npm（npm 随 Node.js 自带，请确认安装）。'); return { ok: false, msg: '未找到 npm' }; }
    let wasRunning = state.running;
    if (state.running && !state.owned) {
      // 外部实例在跑：仅安装到安装根，不停止/不重启现有实例
      pushLog('info', '检测到外部 dsh 实例：跳过停止/重启，仅安装到安装根');
      wasRunning = false;
    }
    if (wasRunning) {
      pushLog('info', '先停止当前 dsh 服务...');
      const s = await stopDsh();
      if (!s.ok) return s;
    }
    let ok = false, lastErr = '';
    for (const m of cfg.mirrors) {
      pushLog('info', '安装 ' + cfg.dshPackage + '@latest（源: ' + m + '，预计 1 分钟内）...');
      const r = await runCmd('npm', [
        'install', cfg.dshPackage + '@latest', '--prefix', cfg.installRoot, '--registry=' + m
      ], { timeoutMs: 120000 });
      if (r.ok) { ok = true; pushLog('info', '安装成功（源: ' + m + '）'); break; }
      lastErr = r.timedOut ? '安装超时(5分钟)' : (r.err.trim().split(/\r?\n/).slice(-2).join(' ') || '安装失败');
      pushLog('warn', '该源安装失败，切换下一个... ' + lastErr);
    }
    if (!ok) {
      pushLog('error', '所有镜像都失败，更新中止。最后原因: ' + lastErr);
      // 关键防护：更新失败时若原本有壳管理的服务，尝试恢复（避免"停掉后没重启"丢服务）
      if (wasRunning) { pushLog('info', '更新失败，尝试恢复原 dsh 服务...'); await startDsh(); }
      return { ok: false, msg: '更新失败: ' + lastErr };
    }
    state.localVersion = localVersion();
    pushLog('info', '更新完成，当前版本: ' + (state.localVersion ?? '未知'));
    if (wasRunning) {
      pushLog('info', '重新启动 dsh...');
      const s = await startDsh();
      if (!s.ok) pushLog('error', '重启失败: ' + s.msg);
    }
    return { ok: true, version: state.localVersion };
  } finally {
    state.busy = false;
    broadcast('status', statusJson());
  }
}

// ---------------------------------------------------------------- 状态检测 ----
let adoptedNotified = false;
async function isNodeProcess(pid) {
  const r = await runCmd('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 });
  if (!r.ok) return false;
  return /^"node.exe"/i.test(r.out.trim());
}
async function detectStatus() {
  const busy = await checkPort(cfg.dshPort);
  const pid = busy ? await findPidOnPort(cfg.dshPort) : null;
  const saved = readPidFile();
  const ownedByUs = busy && pid !== null && saved === pid && (await isNodeProcess(pid));
  state.running = busy;
  state.pid = pid;
  state.owned = ownedByUs;
  state.localVersion = localVersion();
  if (busy && !ownedByUs && !adoptedNotified) {
    adoptedNotified = true;
    pushLog('info', '检测到外部 dsh 进程（PID=' + pid + '，非本壳启动），已锁定停止/更新。');
  }
}

// 心跳：外部变化时刷新状态（启动/停止过程中不打扰）
setInterval(async () => {
  if (state.starting || state.stopping || state.busy) return;
  const up = await checkPort(cfg.dshPort);
  if (up !== state.running) { await detectStatus(); broadcast('status', statusJson()); }
}, 5000);

// ---------------------------------------------------------------- 控制面板 ----
const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness Shell</title>
<style>
:root { --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#dce1ea; --dim:#8b93a3; --ok:#3ddc84; --warn:#ffb454; --err:#ff6b6b; --acc:#4f8cff; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
.wrap { max-width:920px; margin:0 auto; padding:24px 20px 60px; }
.h1row { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
h1 { font-size:20px; margin:0; }
.ver { color:var(--dim); font-size:12px; background:#1c212b; border:1px solid var(--line); border-radius:99px; padding:2px 10px; }
.tagline { color:var(--dim); font-size:12px; margin:8px 0 16px; }
.sub { color:var(--dim); font-size:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
.row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.status-dot { width:12px; height:12px; border-radius:50%; display:inline-block; background:var(--dim); }
.dot-run { background:var(--ok); box-shadow:0 0 8px var(--ok); }
.dot-start { background:var(--warn); animation:blink 1s infinite; }
.dot-stop { background:var(--err); }
@keyframes blink { 50% { opacity:.3; } }
.btn { background:#232936; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; }
.btn:hover:not(:disabled) { background:#2c3342; }
.btn:disabled { opacity:.45; cursor:not-allowed; }
.btn.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
.btn.danger { background:#3a2430; border-color:#5a2c3c; color:#ff9aa0; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:2px 14px; font-size:13px; margin-top:10px; }
.kv b { color:var(--dim); font-weight:400; }
#log { background:#0a0c10; border:1px solid var(--line); border-radius:8px; padding:10px 12px; height:260px; overflow-y:auto; font:12px/1.7 Consolas,monospace; }
#log .t { color:var(--dim); }
#log .info{color:#9fd0ff} #log .warn{color:var(--warn)} #log .error{color:var(--err)}
.msg { padding:8px 12px; border-radius:8px; margin:10px 0 0; font-size:13px; display:none; }
.msg.show { display:block; }
.msg.ok { background:#12311f; color:#7ce8a9; border:1px solid #1e4d32; }
.msg.bad { background:#351822; color:#ff9aa0; border:1px solid #5a2535; }
a { color:var(--acc); }
</style>
</head>
<body>
<div class="wrap">
  <div class="h1row">
    <h1>DeepSeek Harness Shell</h1>
    <span class="ver" id="shellVer">v1.0.0</span>
  </div>
  <div class="tagline">关闭任何窗口都不会停止 dsh 服务 · 原生更新 + 国内镜像兜底 · 面板端口 <span id="portInfo" style="color:var(--acc)">—</span></div>

  <div class="card">
    <div class="row">
      <span class="status-dot" id="dot"></span>
      <b id="statusText">检测中…</b>
    </div>
    <div class="kv" id="kv"></div>
    <div class="sub" id="updHint" style="margin-top:10px;color:var(--ok);display:none"></div>
    <div class="sub" id="extHint" style="margin-top:10px;color:var(--warn);display:none">检测到外部 dsh 实例（非本壳启动）：停止/重启已锁定；「一键安装 / 更新」仅安装到安装根，运行中的实例需自行重启后生效</div>
    <div class="sub" id="nodeWarn" style="margin-top:10px;color:var(--err);display:none">⚠️ Node 版本过低（需要 &gt;= 20）</div>
    <div class="sub" style="margin-top:10px;color:var(--dim);font-size:12px">关闭本窗口后约 120 秒壳自动退出（dsh 服务不受影响）</div>
    <div class="sub" style="margin-top:8px;color:var(--dim);font-size:11px">dsh-shell <span id="shellVer2"></span> · <a href="#" id="reCheck">重新检查更新</a> · <a href="#" id="openBr">在浏览器中打开</a></div>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="btnStart">启动服务</button>
      <button class="btn danger" id="btnStop">停止服务</button>
      <button class="btn" id="btnRestart">重启</button>
      <button class="btn" id="btnUpdate">一键安装 / 更新</button>
      <button class="btn" id="btnOpen">打开 DSH 显示器</button>
    </div>
    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:8px">
      <b>运行日志</b>
      <span style="flex:1"></span>
      <button class="btn" id="btnClearLog" style="padding:4px 10px">清空显示</button>
    </div>
    <div id="log"></div>
  </div>
</div>
<script>
var $ = function(id){ return document.getElementById(id); };
var es = new EventSource('/api/events');
$('shellVer2').textContent = $('shellVer').textContent;
function fmtTime(t){ var d = new Date(t); return d.toLocaleTimeString('zh-CN',{hour12:false}); }
function renderKv(s){
  var kv = $('kv'); kv.innerHTML = '';
  function add(k, v){ var b = document.createElement('b'); b.textContent = k; var sp = document.createElement('span'); sp.textContent = v; kv.appendChild(b); kv.appendChild(sp); }
  add('本机版本', s.localVersion || '未安装');
  add('最新版本', s.latestVersion || '—');
  add('安装位置', s.installRoot);
}
function render(s){
  var dot = $('dot');
  dot.className = 'status-dot' + (s.starting ? ' dot-start' : s.running ? ' dot-run' : '');
  $('statusText').textContent = s.starting ? '启动中…' : s.stopping ? '停止中…' : s.checking ? '检查更新中…' : s.busy ? '安装 / 更新中…' : (s.running ? (s.owned ? '运行中（本壳管理）' : '运行中（外部进程，已锁定）') : '未运行');
  if (s.shellPort && $('portInfo')) $('portInfo').textContent = s.shellPort;
  $('nodeWarn').style.display = s.nodeOk ? 'none' : 'block';
  $('extHint').style.display = (s.running && !s.owned) ? 'block' : 'none';
  // 版本提示：有新版本且（未安装或与本地不一致）→ 提示可更新
  var hasUpdate = !!s.latestVersion && (!s.localVersion || s.latestVersion !== s.localVersion);
  $('updHint').style.display = (hasUpdate && !s.busy && !s.checking) ? 'block' : 'none';
  if (hasUpdate) {
    $('updHint').textContent = s.localVersion
      ? ('发现新版本 ' + s.latestVersion + '（当前 ' + s.localVersion + '）→ 点「一键安装 / 更新」即可升级')
      : ('检测到官方最新 ' + s.latestVersion + '，本机尚未安装 → 点「一键安装 / 更新」即可安装');
  }
  $('btnUpdate').className = 'btn' + (hasUpdate && !s.busy && !s.checking ? ' primary' : '');
  renderKv(s);
  $('btnStart').disabled = s.running || s.starting || s.stopping || s.busy;
  $('btnStop').disabled  = !(s.running && s.owned) || s.stopping || s.busy;
  $('btnRestart').disabled = s.starting || s.stopping || s.busy || (s.running && !s.owned);
  // 外部实例也可更新：updateDsh 走"仅安装到安装根，不重启"分支（extHint 有提示）
  $('btnUpdate').disabled = s.busy || s.stopping;
}
function showMsg(t, kind){ var m = $('msg'); m.textContent = t; m.className = 'msg show ' + (kind||'ok'); }
function appendLogLine(e){
  var el = $('log');
  var div = document.createElement('div');
  var span = document.createElement('span'); span.className = 't'; span.textContent = fmtTime(e.t) + ' ';
  var body = document.createElement('span'); body.className = e.level || 'info'; body.textContent = e.text || '';
  div.appendChild(span); div.appendChild(body);
  el.appendChild(div);
  while (el.children.length > 2000) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
var lastStatus = null;
var wasChecking = false;
es.addEventListener('status', function(e){
  var s = JSON.parse(e.data);
  if (wasChecking && !s.checking && !s.busy) {
    // 检查更新完成：给出明确结果
    if (s.latestVersion && s.localVersion && s.latestVersion === s.localVersion) {
      showMsg('已是最新版本 ' + s.latestVersion, 'ok');
    } else if (s.latestVersion) {
      showMsg(s.localVersion
        ? ('发现新版本 ' + s.latestVersion + '（当前 ' + s.localVersion + '），可点「一键安装 / 更新」')
        : ('官方最新 ' + s.latestVersion + '，本机未安装 → 点「一键安装 / 更新」'), 'ok');
    } else {
      showMsg('检查更新未获取到版本（详见日志）', 'bad');
    }
  }
  wasChecking = s.checking;
  lastStatus = s;
  render(s);
});
es.addEventListener('log', function(e){
  var d = JSON.parse(e.data);
  if (Array.isArray(d.logs)) { $('log').innerHTML = ''; d.logs.forEach(appendLogLine); } else { appendLogLine(d); }
});
es.onerror = function(){ $('statusText').textContent = '连接已断开，请刷新页面'; };
function act(p, okMsg){
  fetch(p, {method:'POST'}).then(function(r){ return r.json(); }).then(function(j){
    if (j.ok) showMsg(okMsg + (j.msg ? '（' + j.msg + '）' : ''), 'ok');
    else showMsg(j.msg || '操作失败', 'bad');
  }).catch(function(e){ showMsg('请求失败: ' + e, 'bad'); });
}
$('btnStart').onclick = function(){ act('/api/start', '启动'); };
$('btnStop').onclick = function(){ act('/api/stop', '停止'); };
$('btnRestart').onclick = function(){ act('/api/restart', '重启'); };
$('btnUpdate').onclick = function(){
  var s = lastStatus || {};
  var tip = '';
  if (s.running && s.owned) tip = '将先停止 dsh 服务，安装完成后自动重启。';
  else if (s.running && !s.owned) tip = '当前为外部 dsh 实例：仅安装到安装根，运行中的实例需自行重启后生效。';
  else tip = 'dsh 未运行，将安装最新版本。';
  var v = '';
  if (s.localVersion) v += '当前 ' + s.localVersion + '，';
  if (s.latestVersion) v += '最新 ' + s.latestVersion + '，';
  if (!confirm((v ? v + '确定' : '确定') + '要安装 / 更新 dsh 吗？\\n' + tip + '\\n安装可能需要几分钟。')) return;
  showMsg('开始安装 / 更新（进度请看日志）…', 'ok');
  fetch('/api/update', {method:'POST'}).then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok && j.msg) showMsg(j.msg, 'bad');
  }).catch(function(e){ showMsg('请求失败: ' + e, 'bad'); });
};
$('btnOpen').onclick = function(){ fetch('/api/open-ui', {method:'POST'}); };
$('reCheck').onclick = function(e){
  e.preventDefault();
  showMsg('开始检查更新（进度看状态与日志）…', 'ok');
  fetch('/api/check-update', {method:'POST'}).then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok && j.msg) showMsg(j.msg, 'bad');
  }).catch(function(err){ showMsg('请求失败: ' + err, 'bad'); });
};
$('openBr').onclick = function(e){ e.preventDefault(); fetch('/api/open-browser', {method:'POST'}); };

$('btnClearLog').onclick = function(){ $('log').innerHTML = ''; };
fetch('/api/status').then(function(r){ return r.json(); }).then(render).catch(function(){
  $('statusText').textContent = '无法连接壳服务（端口可能已变化）：请关闭本窗口，重新双击 start.cmd 打开新面板';
});
</script>
</body>
</html>`;

// ---------------------------------------------------------------- HTTP ----
function sendJson(res, obj, code) {
  const b = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(b)
  });
  res.end(b);
}
function sendText(res, text, type) {
  res.writeHead(200, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') return sendText(res, PANEL_HTML, 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && p === '/api/status') { await detectStatus(); return sendJson(res, statusJson()); }
    if (req.method === 'GET' && p === '/api/logs') {
      const n = Number(url.searchParams.get('tail') ?? 300) || 300;
      return sendJson(res, { logs: ring.slice(-n) });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('event: status\ndata: ' + JSON.stringify(statusJson()) + '\n\n');
      res.write('event: log\ndata: ' + JSON.stringify({ logs: ring.slice(-100) }) + '\n\n');
      sseClients.add(res);
      if (noClientTimer) { clearTimeout(noClientTimer); noClientTimer = null; }
      res.on('error', () => { sseClients.delete(res); scheduleExitIfNoPanel(); });
      req.on('close', () => { sseClients.delete(res); scheduleExitIfNoPanel(); });
      return;
    }
    if (req.method === 'POST' && p === '/api/start') return sendJson(res, await startDsh());
    if (req.method === 'POST' && p === '/api/stop') return sendJson(res, await stopDsh());
    if (req.method === 'POST' && p === '/api/restart') return sendJson(res, await restartDsh());
    if (req.method === 'POST' && p === '/api/check-update') {
      if (state.checking || state.busy) return sendJson(res, { ok: false, msg: '已有任务进行中' });
      checkUpdate(); // 非阻塞：立即返回，进度通过 SSE 推送（状态 + 日志）
      return sendJson(res, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/update') {
      if (state.busy || state.checking) return sendJson(res, { ok: false, msg: '已有任务进行中' });
      updateDsh(); // 非阻塞
      return sendJson(res, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/open-ui') { openDshUi(); return sendJson(res, { ok: true }); }
    if (req.method === 'POST' && p === '/api/open-window') { openPanel(); return sendJson(res, { ok: true }); }
    if (req.method === 'POST' && p === '/api/open-browser') { openBrowser('http://127.0.0.1:' + cfg.shellPort); return sendJson(res, { ok: true }); }
    if (req.method === 'POST' && p === '/api/quit') {
      clearShellPid();
      try { res.end('{"ok":true}'); } catch {}
      setImmediate(() => process.exit(0)); // 立即退出，不依赖长定时器
      return;
    }
    sendJson(res, { ok: false, msg: 'not found' }, 404);
  } catch (e) {
    try { sendJson(res, { ok: false, msg: '服务器错误: ' + e.message }, 500); } catch {}
  }
}

// ---------------------------------------------------------------- 启动 ----
function parseTimeToMs(hms) {
  const m = String(hms).match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return Date.now();
  const d = new Date();
  d.setHours(+m[1], +m[2], +m[3], 0);
  return d.getTime();
}
function seedRing() {
  try {
    const txt = readFileSync(dshLogFile, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean).slice(-100);
    for (const l of lines) {
      const m = l.match(/^\[(.*?)\] \[(\w+)\] (.*)$/);
      ring.push({ t: m ? parseTimeToMs(m[1]) : Date.now(), level: m ? m[2] : 'info', text: m ? m[3] : l });
    }
  } catch {}
}
seedRing();

function writeErrorPage(port, pid) {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-shell 启动失败</title>'
    + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1115;color:#dce1ea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}'
    + '.card{background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:32px;max-width:540px;line-height:1.7}'
    + 'h1{font-size:18px;color:#ff9aa0;margin:0 0 12px}code{background:#0a0c10;padding:2px 6px;border-radius:4px}</style></head>'
    + '<body><div class="card"><h1>dsh-shell 启动失败</h1>'
    + '<p>控制面板端口 <code>' + port + '</code> 已被占用且无响应。</p>'
    + (pid ? '<p>占用进程 PID：<code>' + pid + '</code>（若为残留的旧壳进程，任务管理器结束它即可；<b>不要结束 dsh 服务进程</b>）。</p>' : '')
    + '<p>解决方法：结束残留进程后重新双击 <code>start.cmd</code>，</p>'
    + '<p>或修改 <code>config.json</code> 的 <code>shellPort</code> 换一个端口。</p>'
    + '</div></body></html>';
  try { writeFileSync(path.join(dataDir, 'start-error.html'), html); } catch {}
}

async function getProcessImage(pid) {
  const r = await runCmd('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 });
  if (!r.ok) return '';
  const m = r.out.match(/^"([^"]+)"/);
  return m ? m[1].toLowerCase() : '';
}

async function probeHttp(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 1500);
    const res = await fetch('http://127.0.0.1:' + port + '/api/status', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    return { alive: true, version: j.version || '' };
  } catch { return null; }
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle);
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  await cleanupStaleShell();
  let srv = null;
  let chosenPort = cfg.shellPort;
  // 第一轮：配置端口，重试 3 次（旧壳刚退出时端口可能短暂残留）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      srv = await startServer(chosenPort);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') { shellLog('startup error: ' + e.message); process.exit(1); }
      shellLog('port ' + chosenPort + ' busy (attempt ' + attempt + '/3), probing...');
      const alive = await probeHttp(chosenPort);
      if (alive && alive.alive) {
        if (alive.version === SHELL_VERSION) {
          shellLog('existing panel alive (v' + alive.version + '), opening it and exiting');
          if (cfg.autoOpenBrowser) openPanel();
          process.exit(0);
        }
        // 端口上是旧版壳：清理接管，避免"重启还是旧界面"
        const stalePid = await findPidOnPort(chosenPort);
        shellLog('stale shell v' + (alive.version || '?') + ' on port ' + chosenPort + ' (pid ' + (stalePid || '?') + '), replacing with v' + SHELL_VERSION);
        // 不带 /T：旧壳可能带着独立 dsh，/T 会连带杀掉
        if (stalePid) await runCmd('taskkill', ['/PID', String(stalePid), '/F'], { timeoutMs: 8000 });
        await new Promise(r => setTimeout(r, 1200));
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
    }
  }
  if (!srv) {
    // 清理残留壳：3081 等壳端口上占用者若是 node.exe 即为残留壳（dsh 在 3080，不会占壳端口）
    const holderPid = await findPidOnPort(chosenPort);
    if (holderPid) {
      const img = await getProcessImage(holderPid);
      if (img === 'node.exe') {
        shellLog('stale shell PID ' + holderPid + ' (node.exe) on port ' + chosenPort + ', killing and retrying');
        // 不带 /T：占用者若是旧壳，其独立 dsh 不应被连带杀掉
        await runCmd('taskkill', ['/PID', String(holderPid), '/F'], { timeoutMs: 8000 });
        await new Promise(r => setTimeout(r, 1200));
        try { srv = await startServer(chosenPort); } catch {}
      }
    }
  }
  if (!srv) {
    // 第二轮：自动换端口（+1..+10）——幽灵端口/无法识别的占用者也能正常启动，永不白屏
    for (let delta = 1; delta <= 10; delta++) {
      const cand = cfg.shellPort + delta;
      const alive = await probeHttp(cand);
      if (alive && alive.alive) {
        if (alive.version === SHELL_VERSION) {
          shellLog('port ' + cand + ' has live panel (v' + alive.version + '), opening it and exiting');
          cfg.shellPort = cand; // 打开实际活端口（否则会连向幽灵端口导致白屏）
          if (cfg.autoOpenBrowser) openPanel();
          process.exit(0);
        }
        const stalePid = await findPidOnPort(cand);
        shellLog('stale shell v' + (alive.version || '?') + ' on port ' + cand + ' (pid ' + (stalePid || '?') + '), replacing');
        // 不带 /T：旧壳可能带着独立 dsh，/T 会连带杀掉
        if (stalePid) await runCmd('taskkill', ['/PID', String(stalePid), '/F'], { timeoutMs: 8000 });
        await new Promise(r => setTimeout(r, 1200));
      }
      try { srv = await startServer(cand); chosenPort = cand; break; } catch {}
    }
  }
  if (!srv) {
    const holderPid = await findPidOnPort(chosenPort);
    writeErrorPage(cfg.shellPort, holderPid);
    if (cfg.autoOpenBrowser) {
      const errUrl = 'file:///' + path.join(dataDir, 'start-error.html').replace(/\\/g, '/');
      openAppWindow(errUrl, 'dsh-shell.Error.0', 'edge-profile-err');
    }
    shellLog('startup failed: all ports occupied and unresponsive (pid ' + (holderPid || '?') + ')');
    process.exit(1);
  }
  const usedFallback = chosenPort !== cfg.shellPort;
  cfg.shellPort = chosenPort; // 面板/窗口统一用最终端口
  shellLog('dsh-shell listening on http://127.0.0.1:' + chosenPort);
  writeShellPid();
  await detectStatus();
  broadcast('status', statusJson());
  pushLog('info', 'dsh-shell v' + SHELL_VERSION + ' 就绪 | 安装根: ' + cfg.installRoot + ' | 窗口模式: ' + cfg.windowMode + (usedFallback ? ' | 面板端口: ' + chosenPort + '（默认端口被占，已自动切换）' : ''));
  // WebView2 模式：回收旧的 Edge 显示器 profile（约 300MB）；被占用时静默跳过，下次再试
  if (cfg.windowMode === 'webview2' && existsSync(DISPLAY_EXE)) {
    const oldProfile = path.join(dataDir, 'edge-profile-dsh');
    if (existsSync(oldProfile)) {
      try {
        rmSync(oldProfile, { recursive: true, force: true });
        shellLog('已回收旧 Edge 显示器 profile: edge-profile-dsh');
      } catch { shellLog('edge-profile-dsh 正在使用，跳过回收（下次启动再试）'); }
    }
  }
  if (cfg.autoOpenBrowser) setTimeout(() => openPanel(), 300);
  // 后台：确保快捷方式（非阻塞）
  setTimeout(async () => {
    await ensureDshShortcut();
  }, 500);
  if (cfg.autoCheckUpdate) setTimeout(() => checkUpdate(true), 1500); // 后台快速检查，不阻塞
}

main();

// 防御：任何未处理的 rejection 只记日志，不再崩壳
process.on('unhandledRejection', (reason) => {
  try { shellLog('unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason))); } catch {}
});
process.on('SIGINT', () => { clearShellPid(); pushLog('info', '壳进程退出（dsh 服务不受影响）'); setTimeout(() => process.exit(0), 100); });
process.on('SIGTERM', () => { clearShellPid(); pushLog('info', '壳进程退出（dsh 服务不受影响）'); setTimeout(() => process.exit(0), 100); });
process.on('exit', () => { try { clearShellPid(); } catch {} });
