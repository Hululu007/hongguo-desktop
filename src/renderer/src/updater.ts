// SPDX-License-Identifier: AGPL-3.0-only
// 自动更新状态（渲染层）：订阅主进程 'hg:updater:state' 广播并对外暴露
// useSyncExternalStore 钩子，供设置页与全局更新弹窗共享同一份快照。
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { UpdaterState } from './api';

let snapshot: UpdaterState = {
  phase: 'idle', progress: 0, bps: 0, transferred: 0, total: 0, version: '', error: '', supported: true,
};
const listeners = new Set<() => void>();
let wired = false;

/** 幂等接线：首次订阅时拉取初始快照并挂主进程广播监听 */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  void api.updater.getState().then((state) => {
    snapshot = state;
    listeners.forEach((cb) => cb());
  });
  api.updater.onState((state) => {
    snapshot = state;
    listeners.forEach((cb) => cb());
  });
}

const subscribe = (cb: () => void): (() => void) => {
  ensureWired();
  listeners.add(cb);
  return () => listeners.delete(cb);
};

const getSnapshot = (): UpdaterState => snapshot;

/** 订阅更新状态快照（多组件共享同一广播，不重复建 IPC 监听） */
export function useUpdaterState(): UpdaterState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
