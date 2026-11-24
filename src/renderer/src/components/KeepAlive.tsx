import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

/**
 * 自研 KeepAlive（任务 79）：列表/内容页「真实返回」——跳详情再返回时
 * 复用 DOM 与状态（滚动位置、已加载数据、筛选条件），不重新加载请求。
 *
 * 原理（display 切换，非常用第三方库的 portal 方案）：
 * - 每个缓存路由首次访问时记录 location 快照，之后常驻渲染（各自的 <Routes location={快照}>）；
 * - 非当前路由的缓存层 display:none 隐藏（DOM 保留，组件不卸载，effect 不重跑）；
 * - app-main 共享滚动位置与 ListShell 内部滚动位置在失活前记录、激活后下一帧写回。
 *
 * 注意：缓存页组件内不要使用 useLocation/useSearchParams（这两个 hook 读的是
 * Router 层真实地址，休眠期间会读到其它页面地址导致状态被清）；
 * 路由参数一律用 useParams（跟随 Routes location 快照）或由 App 显式传 props。
 */

/** 缓存层激活状态上下文：缓存页组件据此暂停轮播/恢复滚动等（true=当前可见） */
const CacheActiveContext = createContext(true);

/** 读当前缓存层是否处于激活（可见）状态 */
export function useCacheActive(): boolean {
  return useContext(CacheActiveContext);
}

/**
 * 解析地址对应的缓存键；非缓存路由返回 null。
 * 键格式含动态参数（category:real-drama / rank:hot-drama / actor:123 / search:?keyword=xx），
 * 不同参数 = 不同缓存实例，各自独立保留进度。
 * @param {string} pathname - 路由路径
 * @param {string} search - 查询串（含 ?）
 * @returns {string|null} 缓存键；非缓存路由返回 null
 */
export function cacheKeyOf(pathname: string, search: string): string | null {
  if (pathname === '/') return 'home';
  const category = pathname.match(/^\/category\/([^/]+)$/);
  if (category) return `category:${decodeURIComponent(category[1])}`;
  const rank = pathname.match(/^\/rank(?:\/([^/]+))?$/);
  if (rank) return `rank:${rank[1] ? decodeURIComponent(rank[1]) : ''}`;
  if (pathname === '/actors') return 'actors';
  const actor = pathname.match(/^\/actor\/([^/]+)$/);
  if (actor) return `actor:${decodeURIComponent(actor[1])}`;
  if (pathname === '/search') return `search:${search}`;
  return null;
}

/** 缓存层容器：失活时记录 app-main 滚动位置，激活后下一帧写回；非激活时隐藏整层 */
export function CacheLayer({ active, children }: { active: boolean; children: ReactNode }) {
  /** 失活时的 app-main 滚动位置（首页等页面级滚动共用 app-main，须逐层记忆） */
  const mainScrollRef = useRef(0);
  // 失活记录必须在 render 阶段完成：此时 DOM 尚未变更，能读到真实位置；
  // 拖到 useEffect 读时 display:none 已生效，scrollTop 已被浏览器重置为 0
  if (!active) {
    mainScrollRef.current = document.getElementById('app-main')?.scrollTop ?? 0;
  }
  useEffect(() => {
    if (!active) return;
    const main = document.getElementById('app-main');
    if (!main) return;
    const top = mainScrollRef.current;
    // display 恢复后需等一帧布局完成，scrollTop 才能正确写回
    requestAnimationFrame(() => {
      main.scrollTop = top;
    });
  }, [active]);
  return (
    <CacheActiveContext.Provider value={active}>
      <div style={active ? undefined : { display: 'none' }}>{children}</div>
    </CacheActiveContext.Provider>
  );
}
