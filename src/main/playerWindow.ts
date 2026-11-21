import { BrowserWindow } from 'electron';
import { join } from 'path';

/**
 * 播放器独立窗口（无边框）：详情页/选集点击"播放"时由主进程创建。
 * - 全局单例：已存在时 focus 并发送 player:open 事件让窗口内路由切集
 * - 复用同一 preload，渲染层 window.hongguo 能力完全一致
 */
let playerWin: BrowserWindow | null = null;

/**
 * 获取播放器窗口实例（老板键显隐用）。
 * @returns {BrowserWindow | null} 播放器窗口；不存在或已销毁时返回 null。
 */
export function getPlayerWindow(): BrowserWindow | null {
  return playerWin && !playerWin.isDestroyed() ? playerWin : null;
}

export function createPlayerWindow(seriesId: string, itemId: string): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.focus();
    playerWin.webContents.send('player:open', { seriesId, itemId });
    return;
  }

  playerWin = new BrowserWindow({
    width: 1080,
    height: 608, // 16:9 与视频画面一致（1080×608），实际比例由视频元数据加载后 fitToVideo 校正
    minWidth: 400, // 仅作为绝对下限（控制栏在 400px 以下会被挤压），不影响按视频比例自适应的业务逻辑
    minHeight: 400, // 控制栏纵向可用空间下限
    frame: false, // 无边框：标题由播放器顶部栏自己画（可拖拽 + 关闭按钮）
    backgroundColor: '#000000',
    show: false,
    title: '黑果短剧 · 播放',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 注意：不在此处硬编码 setAspectRatio(16/9) —— 比例必须跟随真实视频
  // （横屏视频→横屏窗口、竖屏视频→竖屏窗口），元数据加载后由 win:fitToVideo 动态设置。

  playerWin.once('ready-to-show', () => playerWin?.show());
  playerWin.on('closed', () => {
    playerWin = null;
  });
  // 窗口被隐藏（老板键 Alt+Q 等）时通知渲染层暂停播放，避免隐藏后声音继续外放
  playerWin.on('hide', () => {
    playerWin?.webContents.send('player:window-hidden');
  });

  // ===== 控制台调试模式（与主窗口一致）：F12 / Ctrl+Shift+I 开关 DevTools =====
  playerWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI =
      input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      playerWin?.webContents.toggleDevTools();
    }
  });

  const hash = itemId ? `#/player/${seriesId}/${itemId}` : `#/player/${seriesId}`;
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    const base = devUrl.endsWith('/') ? devUrl : `${devUrl}/`;
    void playerWin.loadURL(`${base}${hash}`);
  } else {
    void playerWin.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }
}
