import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from './Toast';
import { useUpdaterState } from '../updater';

/**
 * 自动更新弹窗（任务 66-B，三态交互）：
 * - available：窗口启动后延迟 2s 弹「发现新版本」提示（立即升级 / 稍后）；
 *   「稍后」按版本号记忆，同版本不再打扰，手动检查出更新版本仍会提示；
 * - downloading：点击「立即升级」后切换为下载弹窗（进度条 + 速度 + 已下载/总量）；
 * - downloaded：下载完成自动执行安装重启（IPC quitAndInstall，装完自动打开新版本）。
 * 失败提示走轻量 toast（弹窗不渲染 error 态，重试可在设置页手动检查）。
 * UI 对齐关闭确认弹窗（cc-overlay/cc-modal 视觉语言：深色面板 + 品牌渐变徽标）。
 */

/** 字节数 → 用户可读文本 */
const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
};

export function UpdateModal() {
  const state = useUpdaterState();
  /** available 提示是否已到 2s 延迟展示时间 */
  const [promptVisible, setPromptVisible] = useState(false);
  /** 「立即升级」按下后等待主进程切到 downloading 的短暂窗口 */
  const [starting, setStarting] = useState(false);
  /** 「稍后」记忆的版本号：同版本不再弹窗 */
  const dismissedVersion = useRef('');
  /** downloaded 自动安装的防重入标记（每轮 downloaded 仅触发一次 IPC） */
  const installTriggeredRef = useRef(false);
  const lastError = useRef('');
  const showTimer = useRef<number | null>(null);

  // available → 延迟 2s 显示提示弹窗；版本被「稍后」跳过则不弹
  useEffect(() => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    if (state.phase === 'available' && state.version && state.version !== dismissedVersion.current) {
      showTimer.current = window.setTimeout(() => setPromptVisible(true), 2000);
    } else {
      setPromptVisible(false);
    }
    return () => {
      if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    };
  }, [state.phase, state.version]);

  // 下载完成 → 自动执行升级替换（quitAndInstall 装完自动重启打开新版本）
  useEffect(() => {
    if (state.phase === 'downloaded' && !installTriggeredRef.current) {
      installTriggeredRef.current = true;
      void api.updater.install();
    }
    if (state.phase !== 'downloaded') installTriggeredRef.current = false;
  }, [state.phase]);

  // 失败提示走轻量 toast（仅手动检查可见；启动/定时自动检查完全静默，任务 69）
  useEffect(() => {
    if (state.phase === 'error' && state.manual && state.error && state.error !== lastError.current) {
      lastError.current = state.error;
      toast(`自动更新失败：${state.error}`);
    }
    if (state.phase !== 'error') lastError.current = '';
  }, [state.phase, state.error, state.manual]);

  const startDownload = () => {
    if (starting) return;
    setStarting(true);
    void api.updater.download().then((ok) => {
      // 主进程未受理（如状态已变化）时恢复按钮；正常情况下广播会切到下载弹窗
      if (!ok) setStarting(false);
    });
  };

  const showPrompt = state.phase === 'available' && promptVisible && state.version !== dismissedVersion.current;

  // ===== 态一：发现新版本提示（窗口启动后延迟 2s） =====
  if (showPrompt) {
    return (
      <div className="up-overlay">
        <div className="up-modal" role="dialog" aria-modal="true" aria-label="发现新版本">
          <div className="cc-badge">
            <img src="logo.png" alt="" className="cc-badge-logo" />
          </div>
          <h3 className="cc-title">发现新版本</h3>
          <p className="cc-desc">
            黑果短剧 <b className="up-version">v{state.version}</b> 已发布，是否立即升级？
          </p>
          <div className="up-actions">
            <button className="up-btn primary" onClick={startDownload} disabled={starting}>
              {starting ? '正在准备下载…' : '立即升级'}
            </button>
            <button className="up-btn ghost" onClick={() => { dismissedVersion.current = state.version; setPromptVisible(false); }}>
              稍后
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== 态二：下载中（进度条 + 下载信息） =====
  if (state.phase === 'downloading') {
    return (
      <div className="up-overlay">
        <div className="up-modal" role="dialog" aria-modal="true" aria-label="正在下载更新">
          <div className="cc-badge">
            <img src="logo.png" alt="" className="cc-badge-logo" />
          </div>
          <h3 className="cc-title">正在升级到 v{state.version || '?'}</h3>
          <p className="cc-desc">升级包下载中，完成后将自动重启安装</p>
          <div className="up-progress" role="progressbar" aria-valuenow={state.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="up-progress-fill" style={{ width: `${state.progress}%` }} />
          </div>
          <div className="up-meta">
            <span>{state.progress}%</span>
            <span>
              {fmtBytes(state.transferred)} / {fmtBytes(state.total)}
              {state.bps > 0 ? ` · ${fmtBytes(state.bps)}/s` : ''}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ===== 态三：下载完成（自动执行安装重启，短暂展示） =====
  if (state.phase === 'downloaded') {
    return (
      <div className="up-overlay">
        <div className="up-modal" role="dialog" aria-modal="true" aria-label="升级安装">
          <div className="cc-badge">
            <img src="logo.png" alt="" className="cc-badge-logo" />
          </div>
          <h3 className="cc-title">升级包就绪</h3>
          <p className="cc-desc">
            v{state.version} 下载完成，正在重启安装，安装完成后将自动打开新版本…
          </p>
        </div>
      </div>
    );
  }

  return null;
}
