import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { toast } from './Toast';
import { accountStore, pullCloudAll, refreshAccountStatus, resetProgressReport, useAccount } from '../stores';
import { IconLogout, IconSync, IconUser } from './Icons';

/**
 * 顶栏用户头像按钮（设置按钮右侧）：
 * 未登录 → 默认头像占位，点击打开扫码登录弹窗；
 * 已登录 → 显示头像/昵称占位，点击展开下拉菜单（同步进度 / 账号设置 / 退出登录）。
 */
export function AccountButton() {
  const { status, user } = useAccount();
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点击面板其他区域收起下拉
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const onClick = () => {
    if (status === 'loggedIn') setMenuOpen((v) => !v);
    else if (status === 'loggedOut') accountStore.setState({ loginModalOpen: true });
  };

  /** 手动同步：拉云端进度合并本地（上报由历史订阅自动进行） */
  const syncNow = () => {
    if (syncing) return;
    setSyncing(true);
    pullCloudAll()
      .then((r) => {
        const parts: string[] = [];
        if (r.history > 0) parts.push(`${r.history} 条播放进度`);
        if (r.favorites > 0) parts.push(`${r.favorites} 条收藏`);
        toast(parts.length > 0 ? `已从云端同步 ${parts.join('、')}` : '云端暂无新内容');
      })
      .catch((e) => toast(`同步失败：${String((e as Error)?.message ?? e)}`))
      .finally(() => setSyncing(false));
  };

  /** 退出登录：清主进程凭据 → 刷新账号态 → 取消在途防抖上报 */
  const logout = () => {
    setMenuOpen(false);
    api.account.logout()
      .then(() => {
        resetProgressReport();
        void refreshAccountStatus();
        toast('已退出登录，播放进度不再云端同步');
      })
      .catch((e) => toast(`退出失败：${String((e as Error)?.message ?? e)}`));
  };

  return (
    <div className="acct-wrap" ref={wrapRef}>
      <button
        className="tb-icon acct-btn"
        title={status === 'loggedIn' ? `${user?.name ?? '账号'}（点击展开）` : '扫码登录，同步播放进度'}
        aria-label={status === 'loggedIn' ? '账号菜单' : '扫码登录'}
        onClick={onClick}
      >
        {user?.avatar ? (
          <img className="acct-avatar" src={user.avatar} alt="" referrerPolicy="no-referrer" draggable={false} />
        ) : (
          /* public/ 默认头像占位；相对路径规避打包后 file:// 绝对路径 404 */
          <img className="acct-avatar" src="user.svg" alt="" draggable={false} />
        )}
      </button>
      {menuOpen && status === 'loggedIn' ? (
        <div className="acct-menu" role="menu">
          <div className="acct-menu-user">
            <span className="acct-menu-avatar">
              {user?.avatar ? <img src={user.avatar} alt="" referrerPolicy="no-referrer" /> : <IconUser size={18} />}
            </span>
            <span className="acct-menu-meta">
              <span className="acct-menu-name">{user?.name || '红果用户'}</span>
              <span className="acct-menu-id">ID {user?.userId || '—'}</span>
            </span>
          </div>
          <button className="acct-menu-item" role="menuitem" onClick={syncNow} disabled={syncing}>
            <IconSync size={14} />
            <span>{syncing ? '同步中…' : '同步播放进度'}</span>
          </button>
          <button
            className="acct-menu-item"
            role="menuitem"
            onClick={() => { setMenuOpen(false); navigate('/settings'); }}
          >
            <IconUser size={14} />
            <span>账号设置</span>
          </button>
          <button className="acct-menu-item danger" role="menuitem" onClick={logout}>
            <IconLogout size={14} />
            <span>退出登录</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
