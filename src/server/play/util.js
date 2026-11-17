// SPDX-License-Identifier: GPL-3.0-only
// 播放取址模块（src/server/play）共享的工具函数。
// 从 app-source.js 迁出：字符串规整 / URL 编码 / UA 构建 / 片源地址安全校验。
const { getPlaybackDevice, DEFAULT_PROFILE } = require('../native/playback-device');

/**
 * 规整任意值为修剪后的字符串（null/undefined 回落到 fallback）。
 * @param {*} value - 原始值
 * @param {string} [fallback=''] - value 为空时的回落值
 * @returns {string} 修剪后的字符串
 */
function str(value, fallback = '') { return String(value == null ? fallback : value).trim(); }

/**
 * 反转义接口返回的 URL（\/ \u0026 &amp; → / & &）。
 * @param {*} value - 原始 URL 字符串
 * @returns {string} 反转义后的 URL
 */
function cleanUrl(value) { return str(value).replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&'); }

/**
 * 安全解析 JSON 字符串（失败返回 null）。
 * @param {string} value - JSON 文本
 * @returns {Object|null} 解析结果；非法 JSON 返回 null
 */
function jsonBody(value) { try { return JSON.parse(value); } catch { return null; } }

/**
 * Python requests 风格的 URL 编码（encodeURIComponent + Java URLEncoder 语义微调，
 * 与服务端签名校验使用的编码保持一致，签名对 query 必须逐字节匹配）。
 * @param {Object<string,string|number>} values - 键值对
 * @returns {string} a=1&b=2 形式的 query 串
 */
function pythonUrlEncode(values) {
    const encodeValue = (value) => encodeURIComponent(String(value == null ? '' : value))
        .replace(/[!'()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%7E/g, '~');
    return Object.entries(values).map(([k, v]) => `${encodeValue(k)}=${encodeValue(v)}`).join('&');
}

const CRONET_UA_SUFFIX = '; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
/**
 * 按机型档案构建客户端 UA（版本号/机型/Build 号与 query 设备参数同源，保证指纹一致）。
 * @param {{model: string, brand: string, osVersion: string, uaBuild: string}} profile - 机型档案
 * @param {string} version - 客户端版本代码（各接口各自固定，如 71332/72232/74332）
 * @param {{cronet?: boolean}} [options] - 是否附加 Cronet 网络库后缀（播放/弹幕类请求为 true）
 * @returns {string} 完整 User-Agent
 */
function buildUa(profile, version, { cronet = false } = {}) {
    const base = `com.phoenix.read/${version} (Linux; U; Android ${profile.osVersion}; zh_CN; ${profile.model}; Build/${profile.uaBuild}`;
    return cronet ? base + CRONET_UA_SUFFIX : `${base})`;
}

// 兜底 UA（默认机型档案）：仅用于无设备上下文的路径（fallback_api 直连、非内联片源的流 UA）
const VIDEO_UA = buildUa(DEFAULT_PROFILE, '71332', { cronet: true });

/**
 * 片源/接口地址安全校验：仅放行 https、无凭据、443 端口且主机名落在白名单域（含子域）。
 * @param {string} value - 待校验 URL
 * @param {string[]} domains - 允许的根域名列表（如 ['fqnovel.com']）
 * @returns {string} 规范化后的 URL（url.href）
 * @throws {Error} 格式无效（INVALID_RESPONSE）或域名不受支持（SECURITY_BLOCKED）
 */
function checkedUrl(value, domains) {
    let url;
    try { url = new URL(value); } catch (_) { throw Object.assign(new Error('App 片源地址格式无效'), { code: 'INVALID_RESPONSE' }); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
        throw Object.assign(new Error('App 片源返回了不受支持的服务地址'), { code: 'SECURITY_BLOCKED' });
    }
    return url.href;
}

module.exports = { str, cleanUrl, jsonBody, pythonUrlEncode, buildUa, VIDEO_UA, checkedUrl };
