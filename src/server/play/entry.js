// SPDX-License-Identifier: GPL-3.0-only
// 片源解析：spade_a 密钥派生 / spade URL 解密 / 片源地址安全校验 / codec 分级与播放信息解析。
// 迁移自 app-source.js（parseFallback/deriveContentKey/decryptSpadeUrl/checkedUrl/parseEntryPlayInfo）。
const crypto = require('node:crypto');
const logger = require('../services/logger');
const { DEFAULT_PROFILE } = require('../native/playback-device');
const { meetsDownloadQuality } = require('../native/download-quality');
const { str, cleanUrl, jsonBody, buildUa, VIDEO_UA, checkedUrl } = require('./util');

function parseFallback(value) {
    if (typeof value === 'string') { const parsed = jsonBody(value); return parsed?.fallback_api || value; }
    if (Array.isArray(value)) return str(value[0]);
    return str(value?.fallback_api);
}

/**
 * 从 spade_a 派生 16 字节内容解密密钥（CENC/CTR 视频流解密用）。
 * @param {string} value - 接口返回的 spade_a（base64url）
 * @returns {Buffer} 16 字节内容密钥
 * @throws {Error} 密文过短 / 密钥长度非法 / 格式无效时抛出
 */
function deriveContentKey(value) {
    const raw = Buffer.from(str(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (raw.length < 3) throw new Error('spade_a too short');
    let v8 = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
    v8 = Math.min(v8, raw.length - 1);
    if (v8 < 33) throw new Error('spade_a key length invalid');
    const work = Buffer.from(raw.subarray(1, 1 + v8)); let a = 85; let b = 246;
    for (let i = 0; i < v8; i += 1) {
        const old = work[i]; const previous = i & 1 ? a : b;
        if (i & 1) a = old; else b = old;
        const pop = i.toString(2).split('1').length - 1;
        work[i] = (-21 - pop + (previous ^ old)) & 255;
    }
    const hex = work.subarray(1, 33).toString('ascii');
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('App 视频密钥格式无效');
    return Buffer.from(hex, 'hex');
}

/**
 * 解密 spade 加密片源 URL（AES-128-CBC，密钥由 sha512 双轮哈希派生，无填充）。
 * @param {string} value - 加密的 URL（base64）
 * @param {Buffer} seed - key_seed 解码后的种子
 * @returns {string} 解密后的明文 URL
 * @throws {Error} 密文过短 / 头部格式错误 / 无完整密文块时抛出
 */
function decryptSpadeUrl(value, seed) {
    const encoded = str(value); if (!encoded) return '';
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < 5) throw new Error('spade URL ciphertext too short');
    if (raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00) throw new Error('spade URL header format error');
    const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
    if (!cipherLength) throw new Error('spade URL ciphertext has no complete block');
    const constants = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
    const h1 = crypto.createHash('sha512').update(seed).digest(); const h2 = crypto.createHash('sha512').update(Buffer.concat([h1, constants])).digest();
    const decipher = crypto.createDecipheriv('aes-128-cbc', h2.subarray(0, 16), h2.subarray(16, 32));
    decipher.setAutoPadding(false);
    let plaintext = Buffer.concat([decipher.update(raw.subarray(4, 4 + cipherLength)), decipher.final()]);
    if (plaintext.length) {
        const padding = plaintext[plaintext.length - 1];
        if (padding >= 1 && padding <= 16 && padding <= plaintext.length) plaintext = plaintext.subarray(0, plaintext.length - padding);
    }
    while (plaintext.length && plaintext[plaintext.length - 1] === 0) plaintext = plaintext.subarray(0, plaintext.length - 1);
    return plaintext.toString('utf8');
}

const H264_CODECS = ['h264', 'avc', 'avc1'];
const HEVC_CODECS = ['hevc', 'h265', 'hvc1', 'hev1', 'bytevc1'];
const BYTEVC2_CODECS = ['bytevc2', 'bvc2'];

/**
 * 判断编解码标识是否属于 HEVC (H.265) 家族。
 * @param {string} codec - 原始 codec_type 标识
 * @returns {boolean} HEVC 家族返回 true
 */
function isHevcCodec(codec) {
    return HEVC_CODECS.includes(str(codec).toLowerCase());
}

/**
 * 解析上游取址结果（video_model）为可播放的片源变体列表：
 * fallback_api 直连 → codec 分级（H264 直解 / HEVC / ByteVC2 转码，随客户端能力收缩）
 * → spade 密钥派生 → URL 解密与安全校验 → 质量排序（auto 取同分辨率最优集合）。
 * @param {string} vid - 分集编号
 * @param {Object} entry - 上游返回的分集条目（含 video_model）
 * @param {string} requestedQuality - 请求档位（'auto' 或如 '720p'）
 * @param {boolean} allowLowerQuality - 是否允许降到低于请求档位
 * @param {number} deadline - 取址截止时间戳（毫秒）
 * @param {AbortSignal} signal - 中止信号
 * @param {boolean} [allowBytevc2=false] - 是否接受 ByteVC2 编码（ffmpeg 转码兜底）
 * @param {boolean} [allowHevc=true] - 客户端是否支持 HEVC 硬解
 * @param {boolean} [allowHevcTranscode=false] - 是否可用 ffmpeg 为 HEVC 转码兜底
 * @param {Object} [profile] - 机型档案（决定片源流 UA）
 * @returns {Promise<Object>} 首选变体 + variants 全集 + duration
 * @throws {Error} MISSING_MODEL / INVALID_RESPONSE / BUSINESS_REJECTED / UNSUPPORTED_BYTEVC2 / UNSUPPORTED_HEVC / SECURITY_BLOCKED
 */
async function parseEntryPlayInfo(vid, entry, requestedQuality, allowLowerQuality, deadline, signal, allowBytevc2 = false, allowHevc = true, allowHevcTranscode = false, profile = DEFAULT_PROFILE) {
    const model = typeof entry?.video_model === 'string' ? jsonBody(entry.video_model) : entry?.video_model;
    if (!model) throw Object.assign(new Error('App 接口未返回所选分集，已停止取址'), { code: entry?.video_model ? 'INVALID_RESPONSE' : 'MISSING_MODEL' });
    const inline = Array.isArray(model.video_list) && model.video_list.length > 0;
    let info = model;
    if (!inline) {
        const fallback = parseFallback(model.fallback_api);
        if (!fallback) throw Object.assign(new Error('App 接口未返回本集片源地址'), { code: 'MISSING_MODEL' });
        // 传输层（requestJson）留在 app-source：设备会话注入与 Cookie 合并对其余接口同样生效
        const { requestJson } = require('../native/app-source');
        const outer = await requestJson(fallback, { headers: { 'User-Agent': VIDEO_UA } }, deadline, signal);
        if ([outer, outer.video_info].some(value => Number(value?.Code || value?.code || 0) !== 0)) {
            throw Object.assign(new Error('App 接口暂未提供本集播放信息'), { code: 'BUSINESS_REJECTED' });
        }
        info = outer?.video_info?.data;
    }
    if (!info) throw Object.assign(new Error('App 接口未返回本集片源模型'), { code: 'MISSING_MODEL' });
    const candidates = Object.values(info?.video_list || {}).filter(item => item && (item.main_url || item.backup_url || Array.isArray(item.backup_url_list))).map(item => {
        const codec = str(item.codec_type || item.video_meta?.codec_type).toLowerCase();
        // HEVC 感知分级：客户端支持 HEVC 时保持原序（H264→HEVC→ByteVC2）；
        // 不支持时优先 H264 直解，其次 ByteVC2（ffmpeg 转码），最后 HEVC（ffmpeg 转码）
        let codecRank = 3;
        if (H264_CODECS.includes(codec)) {
            codecRank = 0;
        } else if (allowHevc) {
            if (HEVC_CODECS.includes(codec)) codecRank = 1;
            else if (allowBytevc2 && BYTEVC2_CODECS.includes(codec)) codecRank = 2;
        } else {
            if (allowBytevc2 && BYTEVC2_CODECS.includes(codec)) codecRank = 1;
            else if (allowBytevc2 && allowHevcTranscode && HEVC_CODECS.includes(codec)) codecRank = 2;
        }
        const quality = str(item.quality_desc || item.definition || item.video_meta?.definition || item.height || item.vheight);
        const meta = item.video_meta || {};
        const [width, height] = [[item.vwidth, item.vheight], [item.width, item.height], [meta.vwidth, meta.vheight], [meta.width, meta.height]]
            .map(pair => pair.map(Number)).find(pair => pair.every(value => Number.isFinite(value) && value > 0)) || [0, 0];
        const pixels = width && height ? Math.min(width, height) : Number(quality.match(/\d+/)?.[0] || 0);
        return { item, codec, codecRank, quality, pixels, width, height };
    });
    // 可接受档位随 HEVC 能力收缩（有直解档不收进转码档）
    const maxAcceptedRank = allowHevc
        ? (candidates.some(row => row.codecRank < 2) ? 2 : 3)
        : (candidates.some(row => row.codecRank === 0) ? 1 : candidates.some(row => row.codecRank === 1) ? 2 : 3);
    const rows = candidates.filter(row => row.codecRank < maxAcceptedRank
        && (allowLowerQuality || meetsDownloadQuality(row, requestedQuality))).sort((a, b) => {
        if (requestedQuality === 'auto') return b.pixels - a.pixels || a.codecRank - b.codecRank;
        const aMeets = meetsDownloadQuality(a, requestedQuality), bMeets = meetsDownloadQuality(b, requestedQuality);
        if (aMeets !== bMeets) return Number(bMeets) - Number(aMeets);
        const aPixels = Math.min(a.width, a.height), bPixels = Math.min(b.width, b.height);
        return (aMeets ? aPixels - bPixels : bPixels - aPixels) || a.codecRank - b.codecRank;
    });
    if (!allowBytevc2 && !rows.length && candidates.some(row => BYTEVC2_CODECS.includes(row.codec))
        && !candidates.some(row => row.codecRank < 2)) {
        throw Object.assign(new Error('本集使用 ByteVC2 编码，当前播放器暂不支持'), { code: 'UNSUPPORTED_BYTEVC2' });
    }
    if (!allowHevc && !rows.length && candidates.some(row => HEVC_CODECS.includes(row.codec))
        && !candidates.some(row => H264_CODECS.includes(row.codec))) {
        throw Object.assign(new Error('当前设备不支持 HEVC (H.265) 硬件解码，且本集暂无兼容片源'), { code: 'UNSUPPORTED_HEVC' });
    }
    if (!rows.length) throw new Error(requestedQuality === 'auto' || allowLowerQuality
        ? '本集暂未提供兼容的 H.264/HEVC 片源'
        : `本集暂无尺寸可确认且满足 ${requestedQuality} 的 H.264/HEVC 片源，未降级`);
    let lastError;
    const variants = [];
    const seen = new Set();
    // Auto means "best available". Keep every compatible encoding at the same
    // resolution tier, but never silently fall through to a lower rendition.
    const bestPixels = rows[0].pixels;
    const selectedRows = requestedQuality === 'auto'
        ? (bestPixels > 0 ? rows.filter(row => row.pixels === bestPixels) : rows.slice(0, 1))
        : rows;
    for (const selected of selectedRows) {
        try {
            const spade = selected.item.spade_a || selected.item.encrypt_info?.spade_a;
            if (inline && !spade && selected.item.encrypt_info != null
                && ![false, 0, '0', 'false'].includes(selected.item.encrypt_info?.encrypt)) {
                throw Object.assign(new Error('本集片源缺少有效解密信息'), { code: 'INVALID_RESPONSE' });
            }
            const key = spade ? deriveContentKey(spade) : null;
            for (const candidate of [selected.item.main_url, selected.item.backup_url, ...(Array.isArray(selected.item.backup_url_list) ? selected.item.backup_url_list : [])]) {
                if (typeof candidate !== 'string' || !candidate) continue;
                try {
                    const media = info.key_seed
                        ? decryptSpadeUrl(candidate, Buffer.from(info.key_seed, 'base64'))
                        : cleanUrl(candidate);
                    const url = checkedUrl(media, ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com']);
                    const contentKey = key ? key.toString('hex') : null;
                    const identity = `${url}:${contentKey || ''}`;
                    if (seen.has(identity)) continue;
                    seen.add(identity);
                    variants.push({ url, contentKey, codec: selected.codec === 'bytevc1' ? 'hevc' : selected.codec === 'bvc2' ? 'bytevc2' : selected.codec, source: 'app', vid,
                        userAgent: inline ? buildUa(profile, '74332', { cronet: true }) : VIDEO_UA, quality: allowLowerQuality ? (selected.width && selected.height ? `${Math.min(selected.width, selected.height)}p` : '') : requestedQuality === 'auto' ? selected.quality : requestedQuality,
                        ...(requestedQuality === 'auto' ? {} : { width: selected.width, height: selected.height }) });
                } catch (error) { lastError = error; }
            }
        } catch (error) { lastError = error; }
    }
    if (variants.length) return { ...variants[0], variants, duration: Number(model.video_duration || info.video_duration) || 0 };
    logger.warn('PlayEntry', '片源解析失败', { vid, code: lastError?.code || 'INVALID_RESPONSE' });
    throw lastError?.code === 'SECURITY_BLOCKED' ? lastError
        : Object.assign(new Error('本集片源地址或密钥无法解析'), { code: 'INVALID_RESPONSE' });
}

module.exports = { parseFallback, deriveContentKey, decryptSpadeUrl, isHevcCodec, parseEntryPlayInfo, H264_CODECS, HEVC_CODECS, BYTEVC2_CODECS };
