import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from './Toast';
import { accountStore, pullCloudAll, refreshAccountStatus, useAccount } from '../stores';
import { IconClose, IconSync } from './Icons';

/**
 * 扫码登录弹窗（官网 hongguoduanju.com Web passport 协议）：
 * 打开时获取二维码 → 2s 轮询确认状态 → confirmed 落 Cookie 并刷新账号态。
 * 二维码约 60s 过期：底部倒计时进度条；过期后二维码中间显示刷新按钮，点击换新码。
 */

const POLL_INTERVAL_MS = 2000;
const MAX_AUTO_REFRESH = 5;

type Phase = 'loading' | 'waiting' | 'scanned' | 'expired' | 'failed';

export function LoginModal() {
  const { loginModalOpen: open } = useAccount();
  const [phase, setPhase] = useState<Phase>('loading');
  const [qrcode, setQrcode] = useState('');
  const [expireAt, setExpireAt] = useState(0);
  const [expireTotal, setExpireTotal] = useState(60);
  const [round, setRound] = useState(0);
  const [failText, setFailText] = useState('');
  const [now, setNow] = useState(Date.now());
  const tokenRef = useRef('');
  const roundRef = useRef(0);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 停止轮询 */
  const stopPolling = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    busyRef.current = false;
  }, []);

  /** 登录成功：刷新账号态 → 关弹窗 → 后台拉云端进度合并 */
  const finishLogin = useCallback(async (name?: string) => {
    stopPolling();
    await refreshAccountStatus();
    accountStore.setState({ loginModalOpen: false });
    toast(name ? `登录成功，欢迎 ${name}` : '登录成功');
    void pullCloudAll()
      .then((r) => {
        const parts: string[] = [];
        if (r.history > 0) parts.push(`${r.history} 条播放进度`);
        if (r.favorites > 0) parts.push(`${r.favorites} 条收藏`);
        if (parts.length > 0) toast(`已从云端同步 ${parts.join('、')}`);
      })
      .catch(() => {});
  }, [stopPolling]);

  /** 获取新二维码并开始轮询（手动刷新 / 首次进入入口） */
  const startSession = useCallback(async (roundNo: number) => {
    setPhase('loading');
    setFailText('');
    try {
      const s = await api.account.loginStart();
      tokenRef.current = s.token;
      roundRef.current = roundNo;
      setQrcode(s.qrcode);
      setExpireTotal(Math.max(20, Math.min(600, s.expiresInSec)));
      setExpireAt(Date.now() + Math.max(20, Math.min(600, s.expiresInSec)) * 1000);
      setRound(roundNo);
      setPhase('waiting');
      busyRef.current = false;
    } catch (e) {
      setPhase('failed');
      setFailText(String((e as Error)?.message ?? e));
    }
  }, []);

  // 打开即开始；关闭时停止轮询并复位
  useEffect(() => {
    if (open) void startSession(1);
    else stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 轮询循环（单一 interval，打开期间常驻，busy 防重入）
  useEffect(() => {
    if (!open) return;
    timerRef.current = setInterval(() => {
      setNow(Date.now());
      if (busyRef.current || !tokenRef.current) return;
      // 本地倒计时归零直接判过期（服务端轮询可能抖动，体验以本地倒计时为准）
      if (Date.now() >= expireAt) {
        stopPolling();
        setPhase('expired');
        return;
      }
      busyRef.current = true;
      api.account.loginPoll(tokenRef.current)
        .then(async (r) => {
          if (r.status === 'confirmed') { await finishLogin(r.user?.name); return; }
          if (r.status === 'scanned') { setPhase('scanned'); return; }
          if (r.status === 'expired' || r.status === 'canceled') {
            stopPolling();
            setPhase('expired');
            return;
          }
          // pending：保持 waiting
        })
        .catch((e) => {
          // 单次轮询失败不中断会话（网络抖动容错），连续失败交由过期机制兜底
          console.warn('[account] 轮询失败', (e as Error)?.message);
        })
        .finally(() => { busyRef.current = false; });
    }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expireAt]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => accountStore.setState({ loginModalOpen: false });

  /** 过期/手动刷新：换新码（手动刷新不占用自动换新轮数） */
  const refresh = () => { void startSession(Math.min(roundRef.current + 1, MAX_AUTO_REFRESH)); };

  if (!open) return null;

  const remainSec = Math.max(0, Math.ceil((expireAt - now) / 1000));
  const remainPct = expireTotal > 0 ? Math.max(0, Math.min(100, (remainSec / expireTotal) * 100)) : 0;
  const showQr = phase === 'waiting' || phase === 'scanned' || phase === 'expired';

  return (
    <div className="qr-overlay" onMouseDown={close}>
      <div className="qr-modal" role="dialog" aria-modal="true" aria-label="扫码登录" onMouseDown={(e) => e.stopPropagation()}>
        <button className="qr-close" title="关闭" aria-label="关闭" onClick={close}>
          <IconClose size={14} />
        </button>
        <h3 className="qr-title">扫码登录</h3>
        <p className="qr-desc">使用「红果短剧」或「抖音」App 扫一扫</p>
        <div className={`qr-box${phase === 'scanned' ? ' scanned' : ''}`}>
          {phase === 'loading' ? <div className="qr-loading">正在获取二维码…</div>
            : phase === 'failed' ? <div className="qr-failed">{failText || '二维码获取失败'}<button className="btn-primary qr-retry" onClick={() => void startSession(1)}>重新获取</button></div>
              : (
                <>
                  <img className="qr-img" src={qrcode} alt="登录二维码" />
                  {phase === 'scanned' ? <div className="qr-mask">已扫码，请在手机上确认</div> : null}
                  {phase === 'expired' ? (
                    <div className="qr-mask qr-mask-expired">
                      <span>二维码已过期</span>
                      <button className="btn-primary qr-refresh" onClick={refresh}>
                        <IconSync size={13} /> 刷新二维码
                      </button>
                    </div>
                  ) : null}
                </>
              )}
        </div>
        {showQr ? (
          <div className="qr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remainPct)}>
            <i className="qr-progress-fill" style={{ width: `${remainPct}%` }} />
          </div>
        ) : null}
        <p className="qr-status">
          {phase === 'scanned' ? '已扫码，等待手机确认…'
            : phase === 'expired' ? '二维码已过期，请刷新后重新扫码'
              : phase === 'failed' ? '登录未完成'
                : phase === 'loading' ? '请稍候'
                  : `二维码 ${remainSec}s 后失效（第 ${round}/${MAX_AUTO_REFRESH} 轮）`}
        </p>
      </div>
    </div>
  );
}
