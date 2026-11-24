// SPDX-License-Identifier: GPL-3.0-only
// 红果账号服务：官网扫码登录 + 登录态下的账号资料、云端播放记录、收藏与播放进度上报。
// 自参考项目 zfdang/hongguo-open-player src/server/native/account.js 移植（GPL-3.0-only），
// 按本项目结构适配：
//   - 账号域签名复用 app-source.js 的 signedAccountRequest（12 接口白名单，读请求
//     72232 / 写请求 73932）；设备身份取 playback-device 当前注册设备
//     （device_id/iid/cdid/cookie），签名请求显式携带登录 Cookie；
//   - 扫码成功后把整段 Cookie 同步写入 login-state.setToken，播放链路
//     （login-state.authHeaders）自动携带；登出时仅当 login-state 中的 token 与
//     账号 Cookie 同源时才一并清除，绝不覆盖用户手动粘贴的 token；
//   - 凭据落盘为明文 JSON 信封（0o600 权限、.tmp 原子写、.bak 备份）。
//     TODO(safeStorage): Electron 主进程侧可用 safeStorage 加密信封 data 字段
//     （envelope.encrypted=true）；server 层为纯 node 模块拿不到安全解密能力，
//     待与 main 进程约定加解密桥接后再启用，信封结构已预留 encrypted 字段。
// 协议证据（均为公开仓库源码，非官方授权接口，随时可能变更）：
//   - 扫码登录流程：jackotom/hongguo-player src/native/account-session.js（Web passport，
//     hongguoduanju.com，无 x-argus 签名，Cookie jar + CSRF 由官网自身下发）；
//   - 账号接口签名：jackotom signedAccountRequest（GET 72232）+ N3urda/hongguoTV
//     CloudAccount.kt（写请求 73932/7.3.9.32、gzip、x-ss-stub）；
//   - 记录端点与解析：N3urda CloudAccount.kt / HGTV Account.kt（read_progress 为主，
//     read_history 对短剧可能恒空，仅作回退）。
// 纪律：任何失败都转成中文 notice，不向路由抛原始异常；日志与错误文本不得携带
// sessionid / sid_tt / CSRF 等凭据。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const logger = require('../services/logger');
const loginState = require('./login-state');
const { signedAccountRequest } = require('./app-source');
const { getPlaybackDevice } = require('./playback-device');

/** 官网 Web passport 域名（get_qrcode / check_qrconnect / 登录态验证均在此域） */
const WEB_BASE = 'https://hongguoduanju.com';
/** 官网请求 UA（Chromium 桌面口径，与官网网页自身一致） */
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** 官网 passport 接口公共 query（aid=513755 为红果官网 web 应用标识） */
const WEB_QUERY = {
    aid: '513755', passport_jssdk_version: '3.4.10', passport_jssdk_type: 'normal',
    account_sdk_source: 'web', is_from_ttaccountsdk: '1', language: 'zh',
};
/** 账号域 App 接口默认域名 */
const API_HOST = 'api5-normal-sinfonlinea.fqnovel.com';
/** 单请求超时（毫秒） */
const REQUEST_TIMEOUT = 15000;
/** 响应体大小上限（4MB，防异常大包） */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// 大整数字段（vid/series_id 等 19 位）必须在 JSON.parse 前转为字符串，否则丢精度。
const BIG_INT_FIELD = /("(?:vid|video_id|item_id|book_id|series_id|group_id|user_id|biz_user_id)"\s*:\s*)(\d{16,})/g;

/**
 * 归一化为去除首尾空白的字符串（null/undefined 归一为空串）。
 * @param {unknown} value - 任意输入
 * @returns {string} 修剪后的字符串
 */
const str = value => (value === null || value === undefined ? '' : String(value)).trim();

/**
 * 提取字符串中的全部数字字符（如 "7309224106" ← "7309224106abc"），用于剧集/分集编号清洗。
 * @param {unknown} value - 任意输入
 * @returns {string} 仅含 0-9 的字符串
 */
const digits = value => str(value).replace(/[^\d]/g, '');

/**
 * 解析账号接口返回的 JSON：先对 19 位大整数字段加引号防 Number 精度丢失，再 JSON.parse。
 * @param {string} raw - 上游原始响应文本
 * @returns {Object} 解析后的 JSON 对象
 * @throws {SyntaxError} 非 JSON 内容时抛出（由调用方转成中文提示）
 */
function parseApiJson(raw) {
    return JSON.parse(String(raw).replace(BIG_INT_FIELD, '$1"$2"'));
}

/**
 * 秒/毫秒自适应时间戳：小于 1e12 视为秒并 ×1000。仅用于 epoch 时间戳，不用于播放进度。
 * @param {unknown} value - 秒或毫秒时间戳
 * @returns {number} 毫秒时间戳；非法输入返回 0
 */
function toMs(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
}

/**
 * 播放进度/时长字段：上游恒为毫秒，直接取整，不做秒/毫秒猜测。
 * @param {unknown} value - 毫秒值
 * @returns {number} 非负整数毫秒；非法输入返回 0
 */
const plainMs = value => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
};

/**
 * 封面归一：账号接口（收藏/书架/multi-detail）下发的封面是 fqnovelpic 的 HEIC 格式，
 * Chromium 无法解码（naturalWidth=0）。同一图片在 byteimg 公共 CDN 上有无需签名的
 * JPEG 版本（剧场封面即用此格式）。提取图片 hash 重建为 byteimg 地址即可正常显示；
 * 已是 byteimg 或其它格式则原样保留。
 * @param {unknown} url - 原始封面地址
 * @returns {string} 可在 Chromium 中显示的封面地址
 */
function normalizeCover(url) {
    const text = str(url);
    if (!text) return '';
    const match = text.match(/\/novel-pic\/([0-9a-f]{32})/i);
    if (match && /fqnovelpic\.com|\.heic/i.test(text)) {
        return `https://p3-novel.byteimg.com/novel-pic/${match[1]}~tplv-shrink:640:0.image`;
    }
    return text;
}

/**
 * 判断主机名是否属于官网域（含子域），重定向跟随时的安全白名单。
 * @param {string} hostname - URL 主机名
 * @returns {boolean} true 表示是 hongguoduanju.com 及其子域
 */
function isWebHost(hostname) {
    return hostname === 'hongguoduanju.com' || hostname.endsWith('.hongguoduanju.com');
}

/**
 * 脱敏错误文本：去除完整 URL 与凭据键值，截断到 200 字符。
 * 错误/日志文本中不得出现 sessionid/sid_tt/CSRF 等凭据与完整签名 URL。
 * @param {unknown} error - 错误对象或任意文本
 * @returns {string} 脱敏后的短文本
 */
function safeMessage(error) {
    const text = str(error?.message || error);
    return text
        .replace(/https?:\/\/[^\s"']+/g, '[url]')
        .replace(/(sessionid(?:_ss)?|sid_tt|sid_guard|uid_tt(?:_ss)?|passport_csrf_token|d_ticket)=[^;\s"']+/gi, '$1=[redacted]')
        .slice(0, 200);
}

// ── Cookie jar（登录态唯一载体；官网与 App 接口共用同一份凭据） ──────────────
class CookieJar {
    /**
     * @param {() => number} [now] - 当前时间源（测试可注入固定时钟）
     */
    constructor(now = Date.now) { this.map = new Map(); this.now = now; }
    /**
     * 吸收响应 Set-Cookie（支持数组或单个字符串）：解析 k=v 与 max-age，
     * max-age<=0 或空值时删除该 cookie。
     * @param {string[]|string|undefined} setCookie - 响应头 set-cookie 值
     * @returns {void}
     */
    absorb(setCookie) {
        const list = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
        for (const raw of list) {
            const parts = String(raw).split(';');
            const pair = parts[0].trim();
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            let expiresAt = null;
            for (const attr of parts.slice(1)) {
                const [key, ...rest] = attr.trim().split('=');
                const val = rest.join('=').trim();
                if (/^max-age$/i.test(key)) {
                    const seconds = Number(val);
                    if (Number.isFinite(seconds)) expiresAt = seconds <= 0 ? -1 : this.now() + seconds * 1000;
                }
            }
            if (expiresAt === -1 || !value) { this.map.delete(name); continue; }
            this.map.set(name, { value, expiresAt });
        }
    }
    /** 修剪已过期的 cookie（基于 max-age 计算的过期时间） */
    prune() {
        const now = this.now();
        for (const [name, entry] of this.map) if (entry.expiresAt && entry.expiresAt <= now) this.map.delete(name);
    }
    /**
     * 生成请求用的整段 Cookie 串（先修剪过期项，k=v 以 "; " 连接）。
     * @returns {string} Cookie 串；空 jar 返回空串
     */
    cookieString() {
        this.prune();
        return [...this.map.entries()].map(([name, entry]) => `${name}=${entry.value}`).join('; ');
    }
    /**
     * 读取单个 cookie 值。
     * @param {string} name - cookie 名
     * @returns {string} cookie 值；不存在返回空串
     */
    get(name) { this.prune(); return this.map.get(name)?.value || ''; }
    /**
     * 是否已持有登录会话（sessionid 或 sessionid_ss 任一存在）。
     * @returns {boolean} true 表示扫码登录态有效
     */
    hasSession() { return Boolean(this.get('sessionid') || this.get('sessionid_ss')); }
    /**
     * 导出全部 cookie 的快照对象（用于凭据持久化）。
     * @returns {Object<string,string>} { cookie名: cookie值 }
     */
    snapshot() { this.prune(); return Object.fromEntries([...this.map.entries()].map(([name, entry]) => [name, entry.value])); }
    /**
     * 从快照对象恢复 jar（覆盖现有内容；用于启动时还原持久化凭据与失败回滚）。
     * @param {Object<string,string>|null} cookies - 快照对象
     * @returns {void}
     */
    restore(cookies) {
        this.map.clear();
        if (cookies && typeof cookies === 'object') {
            for (const [name, value] of Object.entries(cookies)) if (str(value)) this.map.set(name, { value: str(value), expiresAt: null });
        }
    }
    /** 清空 jar */
    clear() { this.map.clear(); }
    /**
     * 解析 sid_guard 估算会话过期时间。sid_guard = "sessionid|签发秒|max-age秒|…"
     * （可能 URL 编码），过期 = 签发 + max-age。
     * @returns {number} 过期毫秒时间戳；无法解析返回 0
     */
    sessionExpiresAt() {
        const guard = this.get('sid_guard');
        if (!guard) return 0;
        const parts = decodeURIComponent(guard).split('|');
        const issued = Number(parts[1]);
        const maxAge = Number(parts[2]);
        if (!Number.isFinite(issued) || !Number.isFinite(maxAge) || issued <= 0 || maxAge <= 0) return 0;
        return (issued + maxAge) * 1000;
    }
}

/**
 * 创建登录凭据存储器：明文 JSON 信封 {version, encrypted:false, data}，0o600 权限、
 * .tmp 原子写、.bak 备份。TODO(safeStorage)：Electron 主进程可用 safeStorage 加密
 * data 字段并置 encrypted:true；server 层无法解密，见文件头说明。
 * @param {string} dataDir - 数据目录（HONGGUO_DATA_DIR）
 * @param {() => number} [now] - 当前时间源
 * @returns {{file: string, encrypted: boolean, load: Function, save: Function, remove: Function}} 存储器
 */
function createCredentialStore(dataDir, now = Date.now) {
    const file = path.join(dataDir, 'account_session.json');
    return {
        file,
        /** 当前存储是否加密（明文实现恒为 false，供 status 透出） */
        encrypted: false,
        /**
         * 读取并解析持久化凭据；文件不存在返回 null。
         * @returns {{cookies: Object, user?: Object, expires_at?: number, saved_at?: number}|null} 凭据载荷
         * @throws {Error} 文件损坏、JSON 非法或信封为加密形态（当前无法解密）时抛出
         */
        load() {
            let raw;
            try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
            const envelope = JSON.parse(raw);
            // 加密信封由未来的 safeStorage 版本写入；明文实现无法解密，显式报错避免误读
            if (envelope?.encrypted) {
                throw Object.assign(new Error('凭据已加密但当前环境无法解密'), { code: 'CREDENTIAL_LOCKED' });
            }
            const json = envelope?.data;
            const payload = typeof json === 'string' ? JSON.parse(json) : json;
            if (!payload || typeof payload !== 'object' || !payload.cookies) return null;
            return payload;
        },
        /**
         * 原子保存凭据：写 .tmp（0o600）→ 旧文件备份为 .bak → rename 替换正式文件。
         * @param {{cookies: Object, user?: Object, expires_at?: number}} payload - 凭据载荷
         * @returns {void}
         */
        save(payload) {
            fs.mkdirSync(dataDir, { recursive: true });
            const json = JSON.stringify({ ...payload, saved_at: now() });
            const envelope = { version: 1, encrypted: false, data: json };
            const temp = `${file}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
            try { fs.copyFileSync(file, `${file}.bak`); fs.chmodSync(`${file}.bak`, 0o600); } catch (_) { /* 首次无备份 */ }
            fs.renameSync(temp, file);
        },
        /** 删除凭据文件与备份/临时文件 */
        remove() {
            for (const target of [file, `${file}.bak`, `${file}.tmp`]) {
                try { fs.rmSync(target, { force: true }); } catch (_) { /* 忽略 */ }
            }
        },
    };
}

/**
 * 默认设备身份来源：解析当前注册的播放设备（必要时触发注册），只取账号签名
 * 需要的四要素（device_id/iid/cdid/cookie），profile 等其余字段不透出。
 * @returns {Promise<{device_id: string, iid: string, cdid: string, cookie: string}>} 设备身份
 */
async function defaultIdentityProvider() {
    const device = await getPlaybackDevice(require('./app-source').requestJson);
    return {
        device_id: str(device.device_id),
        iid: str(device.iid),
        cdid: str(device.cdid),
        cookie: str(device.cookie),
    };
}

// ── 服务工厂 ────────────────────────────────────────────────────────────────
/**
 * 创建账号服务（单例经 getAccountService 获得；测试可注入时钟/存储/传输层）。
 * @param {Object} [options] - 覆盖项
 * @param {() => number} [options.now] - 当前时间源
 * @param {string} [options.dataDir] - 数据目录（默认 storeService.dataDir）
 * @param {Object} [options.store] - 凭据存储器（默认 createCredentialStore）
 * @param {Function} [options.webTransport] - 官网 HTTP 传输（默认 axios）
 * @param {Function} [options.apiTransport] - App 接口 HTTP 传输（默认 axios）
 * @param {Function} [options.identityProvider] - 设备身份来源（默认播放设备）
 * @returns {Object} 账号服务（startLogin/pollLogin/logout/status/profile/history/
 *   favorites/reportProgress/loggedIn 及测试辅助导出）
 */
function createAccountService(options = {}) {
    const now = options.now || Date.now;
    const dataDir = options.dataDir || require('../services/storeService').dataDir;
    const store = options.store || createCredentialStore(dataDir, now);
    const webTransport = options.webTransport || axios;
    const apiTransport = options.apiTransport || axios;
    const identityProvider = options.identityProvider || defaultIdentityProvider;

    /** 登录态 Cookie jar（官网与 App 接口共用） */
    const jar = new CookieJar(now);
    /** 持久化凭据 {cookies, user:{user_id,name}, expires_at, saved_at} */
    let credentials = null;
    /** 进行中的扫码会话 {token, expireAt} */
    let pendingLogin = null;
    /** 是否已尝试从磁盘恢复凭据（懒恢复一次） */
    let restored = false;

    /**
     * 懒恢复持久化凭据到 jar（进程内仅执行一次）；损坏文件按无登录态处理。
     * 恢复后若 login-state 尚无 token（如用户手动删除），补写一次账号 Cookie，
     * 保证播放链路（authHeaders）继续携带登录态。
     * @returns {void}
     */
    function restore() {
        if (restored) return;
        restored = true;
        try {
            const payload = store.load();
            if (payload?.cookies) {
                jar.restore(payload.cookies);
                credentials = payload;
                syncLoginState(false);
            }
        } catch (error) {
            logger.warn('Account', `登录凭据读取失败: ${safeMessage(error)}`);
            credentials = null;
        }
    }

    /**
     * 把当前 jar 快照合并进 credentials 并落盘（失败仅告警不阻断）。
     * @returns {void}
     */
    function persist() {
        if (!credentials) return;
        credentials = { ...credentials, cookies: jar.snapshot(), expires_at: jar.sessionExpiresAt() || credentials.expires_at || 0 };
        try { store.save(credentials); } catch (error) {
            logger.warn('Account', `登录凭据保存失败: ${safeMessage(error)}`);
        }
    }

    /**
     * 与 login-state 打通：jar 持有会话时把整段 Cookie 写入 login-state.setToken，
     * 播放链路（login-state.authHeaders）即自动携带登录态。
     * @param {boolean} force - true 强制覆盖（刚扫码成功，凭据最新）；
     *   false 仅在 login-state 为空时补写（绝不覆盖用户手动粘贴的 token）
     * @returns {void}
     */
    function syncLoginState(force) {
        if (!jar.hasSession()) return;
        try {
            if (force || !loginState.hasToken()) loginState.setToken(jar.cookieString());
        } catch (error) {
            // Cookie 含登录校验不接受的字符时不阻塞登录（凭据已落盘），仅告警
            logger.warn('Account', `登录态同步到播放链路失败: ${safeMessage(error)}`);
        }
    }

    // ── 官网 Web 传输（手动重定向 + host 白名单 + Cookie 吸收） ──
    /**
     * 官网 HTTPS GET：手动跟随重定向（最多 maxHops 跳），目标域必须命中官网白名单，
     * 每跳吸收 Set-Cookie 到 jar。签名/凭据均不落日志。
     * @param {string} url - 起始地址
     * @param {{maxHops?: number}} [opts] - 最大跳数（默认 5）
     * @returns {Promise<{status: number, data: string, url: string}>} 终态响应
     * @throws {Error} 跳转指向不受信站点 / 跳转次数过多 / 缺少跳转目标时抛出（带 code）
     */
    async function webRequest(url, { maxHops = 5 } = {}) {
        let current = url;
        for (let hop = 0; hop <= maxHops; hop++) {
            const target = new URL(current);
            if (target.protocol !== 'https:' || !isWebHost(target.hostname)) {
                throw Object.assign(new Error('登录跳转指向了不受信任的站点'), { code: 'SECURITY_BLOCKED' });
            }
            const response = await webTransport({
                url: current, method: 'GET',
                headers: {
                    'User-Agent': WEB_UA, Accept: 'application/json, text/plain, */*',
                    Referer: `${WEB_BASE}/`, Origin: WEB_BASE, Cookie: jar.cookieString(),
                },
                timeout: REQUEST_TIMEOUT, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
                validateStatus: () => true, maxContentLength: MAX_RESPONSE_BYTES,
            });
            jar.absorb(response.headers?.['set-cookie']);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers?.location;
                if (!location) throw Object.assign(new Error('登录跳转缺少目标地址'), { code: 'INVALID_RESPONSE' });
                current = new URL(location, current).href;
                continue;
            }
            return { status: response.status, data: response.data, url: current };
        }
        throw Object.assign(new Error('登录跳转次数过多'), { code: 'SECURITY_BLOCKED' });
    }

    /**
     * 官网 passport 接口 JSON 调用：公共 query + 业务参数拼接后走 webRequest。
     * @param {string} apiPath - passport 接口路径（如 /passport/web/get_qrcode/）
     * @param {Object} params - 业务参数
     * @returns {Promise<Object>} 解析后的 JSON 载荷
     * @throws {Error} HTTP 非 200 或响应非 JSON 时抛出（带 code）
     */
    async function webJson(apiPath, params = {}) {
        const query = new URLSearchParams({ ...WEB_QUERY, ...params }).toString();
        const response = await webRequest(`${WEB_BASE}${apiPath}?${query}`);
        if (response.status !== 200) throw Object.assign(new Error(`官网接口返回 HTTP ${response.status}`), { code: 'INVALID_RESPONSE' });
        let payload;
        try { payload = JSON.parse(response.data); } catch (_) {
            throw Object.assign(new Error('官网接口返回了非 JSON 内容'), { code: 'INVALID_RESPONSE' });
        }
        return payload;
    }

    // ── App 接口传输（登录 Cookie 显式携带，不复用 requestJson 的匿名注入） ──
    /**
     * 账号域签名请求与响应校验：设备身份取 identityProvider（播放设备），签名由
     * app-source.signedAccountRequest 生成；响应按 code!==0 / 空响应 / 非 JSON 分类，
     * 全部转成中文错误（原始异常只进日志，不向路由透出）。
     * @param {string} apiPath - 账号域接口路径（白名单内）
     * @param {Object} values - 业务 query 参数
     * @param {Object} [opts] - 附加选项
     * @param {string|Object|null} [opts.payload] - 写请求体（POST；原始 JSON 文本防大整数丢精度）
     * @param {boolean} [opts.gzip] - 请求体是否 gzip（上游写接口契约）
     * @param {string} [opts.host] - 上游域名（默认 API_HOST）
     * @returns {Promise<Object>} 业务码为 0 的解析载荷
     * @throws {Error} 带 code 的中文错误（HTTP/空响应/非 JSON/BUSINESS_REJECTED）
     */
    async function apiRequest(apiPath, values = {}, { payload = null, gzip = false, host = API_HOST } = {}) {
        restore();
        const identity = await identityProvider();
        const signed = signedAccountRequest(apiPath, values, identity, { payload, gzip, host });
        const cookieParts = [str(identity.cookie), jar.cookieString()].filter(Boolean);
        const response = await apiTransport({
            url: signed.url, method: payload !== null ? 'POST' : 'GET',
            headers: { ...signed.headers, Cookie: cookieParts.join('; ') },
            data: signed.body || undefined,
            timeout: REQUEST_TIMEOUT, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
            validateStatus: () => true, maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: MAX_RESPONSE_BYTES,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            throw Object.assign(new Error('账号接口发生不支持的跳转'), { code: 'SECURITY_BLOCKED' });
        }
        if (response.status !== 200) throw Object.assign(new Error(`账号接口返回 HTTP ${response.status}`), { code: 'INVALID_RESPONSE', status: response.status });
        const raw = typeof response.data === 'string' ? response.data : '';
        if (!raw.trim()) throw Object.assign(new Error('账号接口返回空响应（可能登录态或签名失效）'), { code: 'EMPTY_RESPONSE' });
        let parsed;
        try { parsed = parseApiJson(raw); } catch (_) {
            throw Object.assign(new Error('账号接口返回了非 JSON 内容'), { code: 'INVALID_RESPONSE' });
        }
        const code = Number(parsed?.code ?? parsed?.Code ?? parsed?.status_code ?? 0);
        if (code !== 0) {
            throw Object.assign(new Error(`账号接口拒绝请求（code=${code}）`), { code: 'BUSINESS_REJECTED', businessCode: code });
        }
        return parsed;
    }

    /**
     * 未登录统一返回结构（success:false + need_login 标记，路由据此提示扫码）。
     * @returns {{success: boolean, need_login: boolean, items: Object[], notice: string, error: string}} 未登录结果
     */
    const needLogin = () => ({ success: false, need_login: true, items: [], notice: '请先扫码登录红果账号', error: '' });
    /**
     * 失败统一返回结构（notice 与 error 均为面向用户的中文文案，不携带原始堆栈）。
     * @param {string} notice - 中文失败原因
     * @returns {{success: boolean, items?: Object[], notice: string, error: string}} 失败结果
     */
    const fail = notice => ({ success: false, items: [], notice, error: notice });

    /**
     * 当前是否持有登录会话（触发懒恢复）。
     * @returns {boolean} true 表示已登录
     */
    function loggedIn() { restore(); return jar.hasSession(); }

    // ── 扫码登录 ──
    /**
     * 发起扫码登录：向官网申请二维码（get_qrcode），返回 data URI 图与轮询 token。
     * @returns {Promise<{success: boolean, token?: string, qrcode?: string, expire_at?: number, notice: string}>} 二维码信息；失败时 success:false + 中文 notice
     */
    async function startLogin() {
        restore();
        try {
            const payload = await webJson('/passport/web/get_qrcode/', { next: `${WEB_BASE}/` });
            const data = payload?.data || payload || {};
            const token = str(data.token);
            let qrcode = str(data.qrcode || data.qrcode_url);
            if (!token || !qrcode) return fail('官网未返回有效二维码，请稍后重试');
            if (!qrcode.startsWith('data:') && !qrcode.startsWith('http')) qrcode = `data:image/png;base64,${qrcode}`;
            const rawExpire = Number(data.expire_time);
            let expireAt;
            if (Number.isFinite(rawExpire) && rawExpire > 1e12) expireAt = rawExpire;
            else if (Number.isFinite(rawExpire) && rawExpire > 1e9) expireAt = rawExpire * 1000;
            else expireAt = now() + Math.min(Math.max(rawExpire || 180, 30), 600) * 1000;
            pendingLogin = { token, expireAt };
            return { success: true, token, qrcode, expire_at: expireAt, notice: '' };
        } catch (error) {
            logger.warn('Account', `获取登录二维码失败: ${safeMessage(error)}`);
            return fail('获取登录二维码失败，请检查网络后重试');
        }
    }

    /**
     * 跟随扫码确认后的 redirect_url（官网在此跳转中下发登录 Cookie 到 jar）。
     * @param {string} redirectUrl - check_qrconnect 返回的跳转地址
     * @returns {Promise<void>}
     * @throws {Error} 地址为空或跳转被安全白名单拦截时抛出
     */
    async function finishRedirect(redirectUrl) {
        if (!str(redirectUrl)) throw Object.assign(new Error('扫码确认缺少跳转地址'), { code: 'INVALID_RESPONSE' });
        await webRequest(redirectUrl, { maxHops: 5 });
    }

    /**
     * 轮询扫码结果（check_qrconnect）：pending → scanned → confirmed；confirmed 时
     * 跟随 redirect_url 落 Cookie，凭据落盘并同步 login-state；随后尝试拉取官网账号
     * 资料——资料获取失败不阻塞登录成功判定（Cookie 已到手即算成功）。
     * @param {string} token - startLogin 返回的二维码会话标识
     * @returns {Promise<{success: boolean, status?: 'pending'|'scanned'|'expired'|'confirmed', user?: {user_id: string, name: string}, scanned?: boolean, notice: string}>} 轮询结果
     */
    async function pollLogin(token) {
        restore();
        if (!pendingLogin || str(token) !== pendingLogin.token) return fail('二维码会话无效，请刷新二维码');
        if (now() > pendingLogin.expireAt) { pendingLogin = null; return { success: true, status: 'expired', notice: '二维码已过期，请刷新' }; }
        try {
            const payload = await webJson('/passport/web/check_qrconnect/', { next: `${WEB_BASE}/`, token: pendingLogin.token });
            const data = payload?.data || payload || {};
            // 官网返回文字状态：new / scanned / confirmed / expired / canceled（也兼容数字 1/2/3/5）。
            const status = str(data.status ?? payload?.status).toLowerCase();
            if (status === '5' || status === 'expired') { pendingLogin = null; return { success: true, status: 'expired', notice: '二维码已过期，请刷新' }; }
            if (status === '4' || status === 'canceled') { pendingLogin = null; return { success: true, status: 'expired', notice: '扫码已取消，请刷新二维码' }; }
            if (status !== '3' && status !== 'confirmed') {
                return { success: true, status: 'pending', scanned: status === '2' || status === 'scanned', notice: '' };
            }
            await finishRedirect(str(data.redirect_url));
            if (!jar.hasSession()) return fail('扫码已确认，但未获得登录凭据，请重试');
            let user = { user_id: '', name: '' };
            try {
                // 登录态验证与资料展示：失败不阻塞登录成功判定（Cookie 已到手即算成功）
                const info = await webJson('/passport/account/info/v2/', {});
                const infoData = info?.data || info || {};
                user = { user_id: str(infoData.user_id_str || infoData.user_id), name: str(infoData.name || infoData.screen_name || infoData.username) };
            } catch (error) {
                logger.warn('Account', `登录态验证失败（凭据已保存）: ${safeMessage(error)}`);
            }
            credentials = { cookies: jar.snapshot(), user, expires_at: jar.sessionExpiresAt(), saved_at: now() };
            persist();
            // 扫码成功：整段 Cookie 同步写入 login-state，播放链路自动携带
            syncLoginState(true);
            pendingLogin = null;
            logger.info('Account', `扫码登录成功: user_id=${user.user_id || '(未知)'}`);
            return { success: true, status: 'confirmed', user, notice: '' };
        } catch (error) {
            // 登录未成功：回滚 jar，避免失败流程吸收的 Cookie 污染登录态判定。
            jar.restore(credentials?.cookies || {});
            logger.warn('Account', `扫码登录轮询失败: ${safeMessage(error)}`);
            return fail('登录确认失败，请刷新二维码后重试');
        }
    }

    /**
     * 退出登录：清空 jar 与持久化凭据；若 login-state 中的 token 与本次账号 Cookie
     * 同源（值完全一致），一并清除播放链路登录态；手动粘贴的 token 绝不清除。
     * @returns {{success: boolean, notice: string}} 退出结果
     */
    function logout() {
        restore();
        const cookie = jar.cookieString();
        jar.clear();
        credentials = null;
        pendingLogin = null;
        try { store.remove(); } catch (error) { logger.warn('Account', `清除凭据失败: ${safeMessage(error)}`); }
        const state = loginState.getLoginState();
        if (state && state.token === cookie) loginState.clearToken();
        return { success: true, notice: '已退出登录' };
    }

    /**
     * 登录状态查询（供设置页/顶栏展示）：含登录判定、过期估算与存储形态。
     * @returns {{success: boolean, logged_in: boolean, user: Object|null, expires_at: number, expired: boolean, storage_encrypted: boolean, notice: string}} 状态
     */
    function status() {
        restore();
        const expiresAt = jar.sessionExpiresAt() || credentials?.expires_at || 0;
        const expired = Boolean(expiresAt && now() > expiresAt);
        return {
            success: true,
            logged_in: jar.hasSession(),
            user: credentials?.user || null,
            expires_at: expiresAt,
            expired,
            storage_encrypted: store.encrypted,
            notice: !jar.hasSession() ? '' : expired ? '登录态已过期，请重新扫码登录' : '',
        };
    }

    // ── 账号资料（含匿名降级判定） ──
    /**
     * 获取账号资料（/reading/user/info/v1/）。无效 sessionid 不报错而是降级为匿名
     * 账号（biz_user_id 空 / 未设置用户名 / 默认"用户xxxxxx"），由 notice 提示。
     * @returns {Promise<{success: boolean, anonymous?: boolean, user?: {user_id: string, name: string, avatar: string}, need_login?: boolean, notice: string, items?: Object[]}>} 资料
     */
    async function profile() {
        if (!loggedIn()) return needLogin();
        try {
            const payload = await apiRequest('/reading/user/info/v1/', {});
            const data = payload?.data || {};
            const bizUserId = str(data.biz_user_id);
            const userName = str(data.user_name || data.name);
            const anonymous = !bizUserId || data.has_set_username === false || /^用户\d{6,}$/.test(userName);
            return {
                success: true, anonymous,
                user: { user_id: bizUserId || str(data.user_id), name: userName, avatar: str(data.avatar_url || data.avatar) },
                notice: anonymous ? '当前登录态被服务端视为匿名账号，请先在官方红果 App 登录一次后再试' : '',
            };
        } catch (error) {
            logger.warn('Account', `账号资料获取失败: ${safeMessage(error)}`);
            return fail('账号资料获取失败，请稍后重试');
        }
    }

    // ── 记录解析（导出供单测） ──
    /**
     * 把上游进度/书架行归一为条目：剧名在 series_title 或 video_detail.series_title
     * （点赞/收藏的 video_data.title 只是分集宣传文案），进度/时长恒为毫秒。
     * @param {Object|null} row - 上游行
     * @returns {{series_id: string, vid: string, title: string, cover: string, episode_index: number, episode_count: number, position_ms: number, duration_ms: number, watched_at: number}|null} 归一条目；缺剧集编号返回 null
     */
    function mapProgressRow(row) {
        if (!row || typeof row !== 'object') return null;
        const seriesId = digits(row.series_id || row.book_id || row.book_id_str);
        if (!seriesId) return null;
        const detail = row.video_detail && typeof row.video_detail === 'object' ? row.video_detail : {};
        return {
            series_id: seriesId,
            vid: digits(row.vid),
            title: str(row.series_title || detail.series_title || row.book_name),
            cover: normalizeCover(row.series_cover_url || row.cover || row.thumb_url || detail.series_cover_url),
            episode_index: Math.max(1, Number(row.vid_index) || 1),
            episode_count: Math.max(0, Number(row.episode_count || row.episode_cnt || detail.episode_cnt) || 0),
            position_ms: plainMs(row.current_play_time ?? row.current_play_position),
            duration_ms: plainMs(row.current_total_time ?? row.duration),
            watched_at: toMs(row.last_watch_time ?? row.read_timestamp_ms ?? row.last_min_read_timestamp_ms),
        };
    }

    /**
     * 解析 multi-detail 响应为 {剧集编号: {title, cover, episode_count, abstract}} 补充表。
     * @param {Object} payload - multi-detail 载荷（book_data 或对象字典两种形态）
     * @returns {Map<string, {title: string, cover: string, episode_count: number, abstract: string}>} 补充表
     */
    function extractMultiDetail(payload) {
        const data = payload?.data;
        const rows = Array.isArray(data) ? data
            : Array.isArray(data?.book_data) ? data.book_data
            : data && typeof data === 'object' ? Object.values(data).filter(v => v && typeof v === 'object' && !Array.isArray(v)) : [];
        const map = new Map();
        for (const row of rows) {
            const id = digits(row?.book_id || row?.series_id);
            if (id) map.set(id, { title: str(row.book_name || row.series_title), cover: normalizeCover(row.thumb_url || row.series_cover_url || row.cover), episode_count: Number(row.episode_cnt) || 0, abstract: str(row.abstract) });
        }
        return map;
    }

    /**
     * 为缺剧名/封面的条目批量补充元数据（multi-detail，最多 50 部）；尽力而为，
     * 失败仅告警不改变条目。
     * @param {Object[]} items - 归一条目（就地补充 title/cover/episode_count）
     * @returns {Promise<Object[]>} 原条目数组
     */
    async function enrichTitles(items) {
        const missing = [...new Set(items.filter(item => !item.title && item.series_id).map(item => item.series_id))].slice(0, 50);
        if (!missing.length) return items;
        try {
            const payload = await apiRequest('/reading/bookapi/multi-detail/v1/', { book_id: missing.join(','), book_type: '2' });
            const map = extractMultiDetail(payload);
            for (const item of items) {
                const extra = map.get(item.series_id);
                if (!extra) continue;
                if (!item.title) item.title = extra.title;
                if (!item.cover) item.cover = extra.cover;
                if (!item.episode_count) item.episode_count = extra.episode_count;
            }
        } catch (error) {
            logger.warn('Account', `剧集元数据补充失败: ${safeMessage(error)}`);
        }
        return items;
    }

    /**
     * 云端播放记录（read_progress/list/v1/ 为主；空结果时回退 read_history/list/v1/，
     * 后者对短剧可能恒空）。按观看时间倒序；未登录返回 needLogin 结构。
     * @returns {Promise<{success: boolean, items: Object[], source?: string, need_login?: boolean, notice: string, error: string}>} 记录列表
     */
    async function history() {
        if (!loggedIn()) return needLogin();
        try {
            let items = [];
            let source = 'read_progress';
            const payload = await apiRequest('/reading/bookapi/read_progress/list/v1/', { book_types: '2', limit: '50' });
            const data = payload?.data || {};
            // read_progress/list 的 video_data 实测在响应顶层（亦兼容 data / data.data 嵌套）。
            const rows = Array.isArray(payload?.video_data) ? payload.video_data
                : Array.isArray(data.video_data) ? data.video_data
                : Array.isArray(data.data?.video_data) ? data.data.video_data : [];
            items = rows.map(mapProgressRow).filter(Boolean);
            if (!items.length) {
                // 回退：jackotom 的 read_history 端点（HGTV 实测其对短剧可能恒空，故仅作回退）
                source = 'read_history';
                const fallback = await apiRequest('/reading/bookapi/read_history/list/v1/', {
                    book_type: '2', limit: '0', offset: '0', last_min_read_timestamp_ms: '0',
                    full_field: 'true', is_first_load: 'true', query_soft_deleted: 'false',
                });
                const list = Array.isArray(fallback?.data?.data_list) ? fallback.data.data_list : [];
                items = list.filter(row => row && !row.is_delete).map(mapProgressRow).filter(Boolean);
            }
            await enrichTitles(items);
            items.sort((a, b) => b.watched_at - a.watched_at);
            return { success: true, items, source, notice: items.length ? '' : '暂无云端播放记录', error: '' };
        } catch (error) {
            logger.warn('Account', `播放记录获取失败: ${safeMessage(error)}`);
            return fail('播放记录获取失败，请稍后重试');
        }
    }

    /**
     * 收藏记录：App「我的收藏」真实走视频书架 bookshelf/video/info/v1/
     * （data.video_shelf_info，剧集级条目）。协议证据：N3urda/hongguoTV
     * CloudAccount.kt favorites/parseFavorites（源 HGTV AccountParser.favorites）。
     * @returns {Promise<{success: boolean, items: Object[], need_login?: boolean, notice: string, error: string}>} 收藏列表（favorited_at 倒序）
     */
    async function favorites() {
        if (!loggedIn()) return needLogin();
        try {
            const payload = await apiRequest('/reading/bookapi/bookshelf/video/info/v1/', {});
            const rows = Array.isArray(payload?.data?.video_shelf_info) ? payload.data.video_shelf_info : [];
            const items = [];
            const seen = new Set();
            for (const row of rows) {
                if (!row || typeof row !== 'object') continue;
                const video = row.video_data && typeof row.video_data === 'object' ? row.video_data : row;
                const seriesId = digits(video.series_id || row.series_id || row.book_id);
                const title = str(row.series_title || video.title || row.book_name);
                if (!seriesId || !title || seen.has(seriesId)) continue;
                seen.add(seriesId);
                items.push({
                    series_id: seriesId,
                    vid: '',
                    title,
                    cover: normalizeCover(row.series_cover_url || video.cover || video.cover_url || video.thumb_url || row.thumb_url),
                    episode_index: 1,
                    episode_count: Math.max(0, Number(video.episode_cnt || video.episode_count || row.episode_cnt) || 0),
                    position_ms: 0,
                    duration_ms: 0,
                    favorited_at: toMs(row.collect_time),
                });
            }
            await enrichTitles(items);
            items.sort((a, b) => b.favorited_at - a.favorited_at);
            return { success: true, items, notice: items.length ? '' : '暂无收藏记录', error: '' };
        } catch (error) {
            logger.warn('Account', `收藏记录获取失败: ${safeMessage(error)}`);
            return fail('收藏记录获取失败，请稍后重试');
        }
    }

    /**
     * 收藏写入（App「我的收藏」= 视频书架，剧集级 book_id）：add true 加书架 / false 取消收藏。
     * 协议证据：N3urda/hongguoTV CloudAccount.kt setFavorite——
     * bookshelf/video/update/v1/，video_shelf_operate_type 0=加 1=删；
     * shark_extra 仅加书架时附带、group_name 仅取消时置空串；
     * code=0 只是回执，回读书架确认才算成功；业务码 101045 = 该操作已生效（幂等）。
     * @param {string} seriesId - 剧集编号（book_id）
     * @param {boolean} add - true 加收藏 / false 取消收藏
     * @returns {Promise<{success: boolean, confirmed?: boolean, need_login?: boolean, error: string, notice: string}>} 写入结果
     */
    async function setFavorite(seriesId, add) {
        if (!loggedIn()) return { success: false, need_login: true, error: '请先扫码登录红果账号' };
        const bookId = digits(seriesId);
        if (!/^\d{6,30}$/.test(bookId)) return { success: false, error: '剧集编号无效' };
        const entry = { book_id: bookId, book_type: 2, modify_time: Date.now(), video_shelf_operate_type: add ? 0 : 1 };
        if (!add) entry.group_name = '';
        const body = { is_cancelled: false, update_bookshelf_video_list: [entry] };
        if (add) {
            body.shark_extra = {
                enter_from: 'MainFragmentActivity', previous_page: '', page_list: 'MainFragmentActivity',
                is_active_behavior: 'true', inactive_type: '0',
            };
        }
        try {
            await apiRequest('/reading/bookapi/bookshelf/video/update/v1/', {}, {
                payload: JSON.stringify(body),
                gzip: false,
            });
            // code=0 只是回执，回读书架确认才算成功（与预约同一纪律）
            let confirmed = false;
            try {
                const list = await favorites();
                confirmed = Boolean(list.success && (list.items || []).some((item) => item.series_id === bookId)) === add;
            } catch (_) { /* 回读失败不影响提交回执 */ }
            logger.info('Account', `收藏写入: series_id=${bookId}, add=${add}, confirmed=${confirmed}`);
            return {
                success: true, confirmed, error: '',
                notice: confirmed ? '' : '操作已提交，但书架暂未确认，请稍后在收藏记录中查看',
            };
        } catch (error) {
            if (error?.businessCode === 101045) return { success: true, error: '', notice: '该操作已生效' };
            logger.warn('Account', `收藏写入失败(add=${add}): ${safeMessage(error)}`);
            return { success: false, error: '收藏操作失败，请稍后重试' };
        }
    }

    /**
     * 播放进度云端上报（read_progress/upload/v1/，write_mode=1 同时写进度与历史，
     * 官方 App 播放记录可见）。字段名与单位必须精确：毫秒、vid_index 从 1 起、
     * book_id/item_id 用字符串防 19 位精度丢失；用 series_id/vid 等错误键名会
     * 假成功 code=0 但实际不写。入参 positionSec/durationSec 为秒，此处 ×1000。
     * @param {{seriesId: string, vid: string, episodeIndex: number, positionSec: number, durationSec: number, episodeCount?: number}} input - 进度参数
     * @returns {Promise<{success: boolean, need_login?: boolean, error: string}>} 上报结果
     */
    async function reportProgress({ seriesId, vid, episodeIndex, positionSec, durationSec, episodeCount }) {
        if (!loggedIn()) return { success: false, need_login: true, error: '请先扫码登录红果账号' };
        const bookId = digits(seriesId);
        const itemId = digits(vid);
        const index = Number(episodeIndex);
        if (!/^\d{6,30}$/.test(bookId) || !/^\d{6,30}$/.test(itemId) || !Number.isInteger(index) || index < 1) {
            return { success: false, error: '播放上报参数无效' };
        }
        const posMs = Math.max(0, Math.round((Number(positionSec) || 0) * 1000));
        const totalMs = Math.max(0, Math.round((Number(durationSec) || 0) * 1000));
        const rate = totalMs > 0 ? Math.min(1, posMs / totalMs).toFixed(4) : '0';
        const book = {
            book_id: bookId,
            item_id: itemId,
            vid_index: index,
            current_play_time: posMs,
            current_total_time: totalMs,
            read_timestamp_ms: Date.now(),
            book_type: 2,
            progress_rate: rate,
            player_cumulative_total_duration: posMs,
        };
        const count = Number(episodeCount);
        if (Number.isInteger(count) && count > 0) book.episode_count = count;
        try {
            await apiRequest('/reading/bookapi/read_progress/upload/v1/', {}, {
                payload: JSON.stringify({ books: [book], write_mode: 1 }),
                gzip: false,
            });
            return { success: true, error: '' };
        } catch (error) {
            logger.warn('Account', `播放进度上报失败: ${safeMessage(error)}`);
            return { success: false, error: '播放记录同步失败，请稍后重试' };
        }
    }

    return {
        startLogin, pollLogin, logout, status, profile,
        history, favorites, setFavorite, reportProgress,
        loggedIn,
        // 测试与复用需要的内部件
        _jar: jar, _apiRequest: apiRequest, _webJson: webJson,
        mapProgressRow, extractMultiDetail, normalizeCover,
    };
}

/** 进程内单例（首次调用时创建，数据目录取 storeService.dataDir） */
let singleton = null;

/**
 * 获取账号服务单例。
 * @returns {ReturnType<createAccountService>} 账号服务
 */
function getAccountService() {
    if (!singleton) singleton = createAccountService();
    return singleton;
}

/**
 * 重置单例（仅供测试）。
 * @returns {void}
 */
function resetAccountService() { singleton = null; }

module.exports = {
    createAccountService, getAccountService, resetAccountService,
    CookieJar, parseApiJson, toMs, safeMessage, isWebHost, normalizeCover,
    WEB_BASE, WEB_QUERY, API_HOST,
};
