// SPDX-License-Identifier: GPL-3.0-only
const { CookieJar, Cookie } = require('tough-cookie');
const crypto = require('node:crypto');

const PLAYBACK_URL = 'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1';
const IDENTITY_COOKIES = new Set(['install_id', 'store-region', 'store-region-src']);

/**
 * 从设备身份构建会话 CookieJar。
 * 优先反序列化持久化的 cookie_jar；旧版仅存 cookie 字符串时，只迁移三个协议身份
 * cookie（install_id/store-region/store-region-src）到两个受支持的 API 域，
 * 绝不迁移 token 类 cookie（避免把过期会话误当身份复用）。
 * @param {{cookie?: string, cookie_jar?: unknown}} device - 设备身份（含可选 jar 序列化数据）
 * @returns {CookieJar} 就绪的会话 Jar
 */
function createJar(device) {
    if (device.cookie_jar) {
        try { return CookieJar.deserializeSync(device.cookie_jar); } catch (_) { /* Migrate old/corrupt stores below. */ }
    }
    const jar = new CookieJar();
    // Legacy files have no scope information. Only the three protocol identity
    // cookies are shared with the two supported API families; never migrate tokens.
    for (const pair of String(device.cookie || '').split(';')) {
        const cookie = Cookie.parse(pair.trim());
        if (!cookie || !IDENTITY_COOKIES.has(cookie.key)) continue;
        for (const domain of ['fqnovel.com', 'snssdk.com']) {
            jar.setCookieSync(`${cookie.cookieString()}; Domain=${domain}; Path=/; Secure`, `https://${domain}/`, { ignoreError: true });
        }
    }
    return jar;
}

/**
 * 把响应 set-cookie 写入会话 Jar（域/路径/过期由 tough-cookie 校验）。
 * ttreq 刻意排除：现有协议视其为一次性请求令牌而非可复用会话 cookie。
 * Max-Age 在接收时固化为绝对过期时间戳，防止后续读取/重启延长相对寿命。
 * @param {CookieJar} jar - 会话 Jar
 * @param {string} url - 响应对应 URL（作用域判定）
 * @param {Object} [headers] - 响应头（含 set-cookie）
 * @returns {{received: number, accepted: number, rejected: number}} set-cookie 处理统计
 */
function applyCookies(jar, url, headers = {}) {
    const raw = headers['set-cookie'];
    const rows = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    let accepted = 0, rejected = 0;
    for (const row of rows) {
        const parsed = typeof row === 'string' && Cookie.parse(row);
        if (!parsed || parsed.key.toLowerCase() === 'ttreq') { rejected++; continue; }
        if (typeof parsed.maxAge === 'number') {
            parsed.expires = new Date(parsed.maxAge <= 0 ? 0 : Math.min(Date.now() + parsed.maxAge * 1000, 8640000000000000));
            parsed.maxAge = null;
        }
        try {
            const stored = jar.setCookieSync(parsed, url);
            if (stored) accepted++; else rejected++;
        } catch (_) { rejected++; }
    }
    return { received: rows.length, accepted, rejected };
}

/**
 * 序列化 Jar 全量 cookie（剥离 lastAccessed 运行时字段），供持久化与变更比对。
 * @param {CookieJar} jar - 会话 Jar
 * @returns {string} cookie 数组的 JSON 串
 */
function cookieState(jar) {
    return JSON.stringify(jar.serializeSync().cookies.map(({ lastAccessed, ...cookie }) => cookie));
}

/**
 * Jar 在目标 URL 上的会话诊断信息（cookie 名单/数量/最近过期时间）。
 * @param {CookieJar} jar - 会话 Jar
 * @param {string} url - 目标 URL
 * @param {number} [now=Date.now()] - 当前时间戳（毫秒）
 * @returns {{cookie_names: string[], cookie_count: number, cookie_next_expiry_at: number|null, cookie_expiry_remaining_ms: number|null}} 诊断信息
 */
function cookieInfo(jar, url, now = Date.now()) {
    const cookies = jar.getCookiesSync(url);
    const expiries = cookies.map(c => c.expiryTime()).filter(Number.isFinite);
    return {
        cookie_names: cookies.map(c => c.key).sort(),
        cookie_count: cookies.length,
        cookie_next_expiry_at: expiries.length ? Math.min(...expiries) : null,
        cookie_expiry_remaining_ms: expiries.length ? Math.max(0, Math.min(...expiries) - now) : null,
    };
}

/**
 * 设备会话短标识（sha256 前 12 位），日志诊断用，不泄露完整身份。
 * @param {{device_id: string, iid: string, cdid: string}} device - 设备身份
 * @returns {string} 12 位十六进制标识
 */
function deviceKey(device) {
    return crypto.createHash('sha256').update(`${device.device_id}:${device.iid}:${device.cdid}`).digest('hex').slice(0, 12);
}

module.exports = { createJar, applyCookies, cookieInfo, cookieState, deviceKey, PLAYBACK_URL };
