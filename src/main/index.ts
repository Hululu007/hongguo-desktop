import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';
import { appState, createMainWindow, createTray, showMainWindow } from './window';
import { initUpdater } from './updater';

app.setName('黑果短剧');

/** 单实例锁：第二个实例触发已有窗口前置 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });

  registerIpc();

  void app.whenReady().then(() => {
    createMainWindow();
    createTray();
    // 自动更新（任务 66）：注册 IPC + 接线事件 + 定时检查（不支持的环境自动降级）
    initUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    appState.quitting = true; // 让 close 拦截放行真正退出（含托盘菜单退出）
  });

  app.on('window-all-closed', () => {
    // 窗口全部关闭即退出（最小化到托盘时窗口仅隐藏，不触发这里）
    app.quit();
  });
}
