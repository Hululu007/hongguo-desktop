// SPDX-License-Identifier: AGPL-3.0-only
// 自动更新服务（任务 66-B）：electron-updater + GitHub Releases，交互驱动的升级流程。
// - 启动时非阻塞检查 Releases 版本（autoDownload=false，不后台自动下载）；
// - 发现新版本 → 渲染层窗口启动后延迟 2s 弹「立即升级」提示 → 用户点击后经
//   'hg:updater:download' IPC 触发后台下载（进度条 + 速度广播）→ 下载完成渲染层
//   再经 'hg:updater:install' IPC 执行 quitAndInstall（装完自动重启打开新版本）；
// - 手动检查（设置页「关于」）走同一状态机，结果与「立即升级」共用同一弹窗；
// - 便携版（PORTABLE_EXECUTABLE_DIR）无固定安装目录，不支持自动更新 → 状态置为
//   unsupported，设置页隐藏开关并提示；开发模式同样跳过真实检查。
import { BrowserWindow, app, ipcMain } from 'electron';
// electron-updater 主入口（out/main.js）里 autoUpdater 是 Object.defineProperty 惰性 getter、
// 类导出是链式赋值 → rollup 内联打包时无法静态解析任何导出。
// 这里深导入单类文件（out/NsisUpdater.js 等为简单 exports.X = X 赋值，可被正确转换），
// 并参照其内部 doLoadAutoUpdater 按平台实例化对应 Updater
import { AppImageUpdater } from 'electron-updater/out/AppImageUpdater';
import { MacUpdater } from 'electron-updater/out/MacUpdater';
import { NsisUpdater } from 'electron-updater/out/NsisUpdater';
const autoUpdater =
  process.platform === 'win32'
    ? new NsisUpdater()
    : process.platform === 'darwin'
      ? new MacUpdater()
      : new AppImageUpdater();

/** 更新状态机阶段 */
export type UpdaterPhase =
  | 'idle' // 空闲（未检查或已是最新版本）
  | 'checking' // 检查更新中
  | 'available' // 发现新版本（等待用户确认下载）
  | 'downloading' // 下载中（progress 0-100）
  | 'downloaded' // 下载完成（即将执行安装重启）
  | 'error' // 检查/下载失败（error 携带简短原因）
  | 'unsupported'; // 便携版/开发模式不支持自动更新

/** 渲染层可见的更新状态快照 */
export interface UpdaterState {
  phase: UpdaterPhase;
  /** 下载进度百分比（0-100，仅 downloading 阶段有效） */
  progress: number;
  /** 下载速度（字节/秒，仅 downloading 阶段有效） */
  bps: number;
  /** 已下载字节数（仅 downloading 阶段有效） */
  transferred: number;
  /** 安装包总字节数（仅 downloading 阶段有效） */
  total: number;
  /** 新版本号（available/downloading/downloaded 阶段有效） */
  version: string;
  /** 失败原因（error 阶段有效，已做用户可读化） */
  error: string;
  /** 便携版/开发模式不支持自动更新 */
  supported: boolean;
  /** 本轮检查是否用户手动触发（自动检查完全静默，仅手动检查的结果才提示） */
  manual: boolean;
}

/** 自动检查间隔（6 小时） */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后首次检查延迟（8 秒，避开启动期网络竞争） */
const FIRST_CHECK_DELAY_MS = 8000;

let state: UpdaterState = {
  phase: 'idle',
  progress: 0,
  bps: 0,
  transferred: 0,
  total: 0,
  version: '',
  error: '',
  supported: true,
  manual: false,
};
let enabled = true;
let checkTimer: NodeJS.Timeout | null = null;
let firstCheckTimer: NodeJS.Timeout | null = null;
let quitInstalled = false;

/** 便携版判定：electron-builder portable 启动时注入该环境变量 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

/** 自动更新是否可用（需打包后的 NSIS 安装版；dev 下无 app-update.yml 必然报错） */
export function isUpdaterSupported(): boolean {
  if (isPortable()) return false;
  // dev 运行兜底：新版 Electron 下 dev 方式（electron .）isPackaged 也可能返回 true，
  // 用 execPath 落在 node_modules/electron/dist 内来识别开发环境
  if (/node_modules[\\/]electron[\\/]dist[\\/]/i.test(process.execPath)) return false;
  return app.isPackaged;
}

/** 向全部窗口广播状态快照 */
function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('hg:updater:state', state);
  }
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch };
  broadcast();
}

/** 把 electron-updater 的英文报错转成用户可读的一句话 */
function humanizeError(err: Error | unknown): string {
  const message = String((err as Error)?.message ?? err ?? '');
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|ECONNREFUSED|timeout/i.test(message)) return '网络不可用，请稍后重试';
  if (/404|release.*not.*found/i.test(message)) return '尚未发布任何版本';
  if (/signature|checksum/i.test(message)) return '更新包校验失败';
  if (/ENOENT.*app-update\.yml/i.test(message)) return '更新配置缺失（app-update.yml），请重新安装应用';
  return message.length > 80 ? `${message.slice(0, 80)}…` : message;
}

/**
 * 触发一轮检查（enabled=false 或不支持时静默跳过）。
 * 发现新版本只置 available 状态提示用户，不自动下载（交互驱动的升级流程）。
 * @param {boolean} [manual=false] - 是否用户手动触发（手动触发不受开关限制，便于开关关闭时按需检查）
 * @returns {Promise<void>} 检查完成（结果经状态广播回渲染层，本函数不返回结果）
 */
async function runCheck(manual = false): Promise<void> {
  if (!isUpdaterSupported()) return;
  if (!manual && !enabled) return;
  // 下载中/已就绪时不重复检查；available 状态允许重复检查（刷新版本号）
  if (state.phase === 'downloading' || state.phase === 'downloaded') return;
  try {
    setState({ phase: 'checking', error: '', manual });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // 检查失败不打断使用：仅记状态（后台定时检查的失败静默，手动检查的失败用户可见）
    console.warn('[updater] 检查失败:', (err as Error)?.message ?? err);
    setState({ phase: 'error', error: humanizeError(err) });
  }
}

/**
 * 用户点击「立即升级」后触发下载（'hg:updater:download' IPC）。
 * 仅 available 状态可发起；下载中重复调用返回 false 防重入。
 * @returns {Promise<boolean>} 是否真正发起了下载
 */
async function runDownload(): Promise<boolean> {
  if (!isUpdaterSupported() || state.phase !== 'available') return false;
  try {
    setState({ phase: 'downloading', progress: 0, bps: 0, transferred: 0, total: 0, error: '' });
    await autoUpdater.downloadUpdate();
    return true;
  } catch (err) {
    console.warn('[updater] 下载失败:', (err as Error)?.message ?? err);
    setState({ phase: 'error', error: humanizeError(err) });
    return false;
  }
}

/**
 * 启用/禁用自动检查（设置页开关接线）。
 * 禁用仅停止"自动"检查与提示，已下载的版本仍会在退出时静默安装。
 * @param {boolean} value - true 开启定时检查；false 关闭定时器
 * @returns {void}
 */
function setEnabled(value: boolean): void {
  enabled = value;
  if (firstCheckTimer) { clearTimeout(firstCheckTimer); firstCheckTimer = null; }
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  if (value && isUpdaterSupported()) {
    firstCheckTimer = setTimeout(() => { void runCheck(); }, FIRST_CHECK_DELAY_MS);
    checkTimer = setInterval(() => { void runCheck(); }, CHECK_INTERVAL_MS);
    checkTimer.unref?.();
  }
}

/**
 * 初始化自动更新（主进程 ready 后调用一次）：
 * 注册 IPC、接线事件、按默认开启启动定时检查。
 * @returns {void}
 */
export function initUpdater(): void {
  state.supported = isUpdaterSupported();
  if (!state.supported) {
    state = { ...state, phase: 'unsupported', supported: false };
  }

  // 仅检查不自动下载：发现新版本后由用户在弹窗中确认，再经 IPC 触发下载（任务 66-B）
  autoUpdater.autoDownload = false;
  // 用户在下载完成后应用意外退出也不丢更新：退出时静默装新版（下次启动即新版本）
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => {
    // 保留 available 阶段等用户确认；已有版本号时保持不变（重复检查刷新）
    setState({ phase: 'available', progress: 0, bps: 0, transferred: 0, total: 0, version: info.version, error: '' });
  });
  autoUpdater.on('update-not-available', () => setState({ phase: 'idle', version: '', error: '' }));
  autoUpdater.on('download-progress', (p) => {
    setState({
      phase: 'downloading',
      progress: Math.round(p.percent),
      bps: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState({ phase: 'downloaded', progress: 100, bps: 0, transferred: state.total, total: state.total, version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // 已下载完成后才报错（如校验失败）不覆盖 downloaded 提示
    if (state.phase === 'downloaded') return;
    console.warn('[updater] error:', (err as Error)?.message ?? err);
    setState({ phase: 'error', error: humanizeError(err) });
  });

  // 渲染层 API
  ipcMain.handle('hg:updater:get-state', () => state);
  ipcMain.handle('hg:updater:set-enabled', (_e, value: boolean) => {
    setEnabled(Boolean(value));
    return state;
  });
  ipcMain.handle('hg:updater:check', () => runCheck(true));
  ipcMain.handle('hg:updater:download', () => runDownload());
  ipcMain.handle('hg:updater:install', () => {
    if (state.phase !== 'downloaded' || quitInstalled) return false;
    quitInstalled = true;
    // (false, true)：运行完整安装器（非静默），装完自动重启应用
    autoUpdater.quitAndInstall(false, true);
    return true;
  });

  if (state.supported) setEnabled(true);
}
