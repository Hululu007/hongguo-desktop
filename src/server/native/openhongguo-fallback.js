// SPDX-License-Identifier: GPL-3.0-only
// 终局播放兜底：经 beilunyang/openhongguo SDK（Go/WASM，clean-room 签名实现）解析播放模型。
// 仅在自研播放阶梯（app-source 三轮设备全空响应）耗尽后调用，正常播放不经过本模块。
// 上游发布签名/风控修复时，npm 升级 openhongguo 包即可恢复播放，无需改动项目代码。
const path = require('node:path');
const os = require('node:os');
const logger = require('../services/logger');
const { DEFAULT_PROFILE } = require('./playback-device');

// 设备档案持久化路径（与 playback-device 同一数据目录约定，权限 0600 由 SDK 保证）
const DATA_DIR = process.env.HONGGUO_DATA_DIR || path.join(os.tmpdir(), 'hongguo-data');
const PROFILE_FILE = path.join(DATA_DIR, 'openhongguo-profile.json');
const H264_CODECS = ['h264', 'avc', 'avc1'];
const HEVC_CODECS = ['hevc', 'h265', 'hvc1', 'hev1', 'bytevc1'];
const BYTEVC2_CODECS = ['bytevc2', 'bvc2'];

/** 播放流下载 UA（与 app-source 播放域 UA 同构，机型取默认档案） */
const STREAM_UA = `com.phoenix.read/74332 (Linux; U; Android ${DEFAULT_PROFILE.osVersion}; zh_CN; ${DEFAULT_PROFILE.model}; Build/${DEFAULT_PROFILE.uaBuild}; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)`;

/** 客户端单例 promise（懒加载，失败时清空以便下次重试） */
let clientPromise = null;

/**
 * 懒加载 openhongguo 客户端单例（首次调用加载 WASM 并复用持久化设备档案）。
 * @returns {Promise<object>} openhongguo Client 实例
 * @throws {Error} SDK 加载失败（WASM 不可用/依赖缺失）时抛出
 */
function getClient() {
    if (!clientPromise) {
        clientPromise = (async () => {
            // openhongguo 是 ESM-only 包（type: module，named exports）且内部用 import.meta.url
            // 定位 dist 下的 WASM：必须保持 external 并用动态 import() 加载。
            // CJS require 会报 ERR_REQUIRE_ESM；打包进 bundle 会破坏其 WASM 路径定位。
            const oh = await import('openhongguo');
            return oh.createClient({
                profile: oh.fileProfileStore(PROFILE_FILE),
                transport: oh.nodeTransport({ timeoutMs: 8000 }),
                log: () => {},
            });
        })().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
}

/**
 * 规范化编解码标识（与 app-source parseEntryPlayInfo 同规则）。
 * @param {string} codec - SDK 返回的 codec 标识
 * @returns {string} 规范化后的 codec
 */
function normalizeCodec(codec) {
    const raw = String(codec || '').toLowerCase();
    if (raw === 'bytevc1') return 'hevc';
    if (raw === 'bvc2') return 'bytevc2';
    return raw || 'h264';
}

/**
 * 为 promise 附加超时与中止信号（SDK transport 不支持 AbortSignal，此处外层裁剪）。
 * @param {Promise<object>} promise - 目标 promise
 * @param {number} timeoutMs - 超时毫秒数
 * @param {AbortSignal} [signal] - 中止信号
 * @returns {Promise<object>} 原 promise 的结果
 * @throws {Error} 超时或被中止时抛出对应错误
 */
function withDeadline(promise, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('兜底解析超时'), { code: 'OPENHONGGUO_TIMEOUT' })), timeoutMs);
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason || new Error('已中止')); };
        if (signal) {
            if (signal.aborted) { clearTimeout(timer); return onAbort(); }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        promise.then(
            (value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

/**
 * 终局兜底解析：调用 openhongguo SDK 解析单集播放模型，映射为与
 * parseEntryPlayInfo 一致的信息结构（url/variants/contentKey/codec/quality/duration）。
 * 单次调用内部由 SDK 自管换机（deviceResets=2，互斥防风暴），本函数失败静默返回 null，
 * 由调用方上抛自研阶梯的原始错误。
 * @param {string} vid - 分集编号
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - 中止信号与超时
 * @returns {Promise<object|null>} 播放信息（结构与 fetchAppPlayUrl 返回契约一致）；失败返回 null
 */
async function resolveViaOpenhongguo(vid, { signal, timeoutMs = 10000 } = {}) {
    let client;
    try {
        client = await withDeadline(getClient(), timeoutMs, signal);
        const result = await withDeadline(client.resolvePlayback(String(vid)), timeoutMs, signal);
        const playback = result?.playback;
        if (!playback || !Array.isArray(playback.streams)) return null;
        const contentKeyHex = result.contentKey?.key || null;
        // 只取单文件 mp4 表示（hls/dash 本地管线不处理）；优先 H264，其次码率高者
        const streams = playback.streams
            .filter(s => s && (s.url || s.backup_url) && !s.hls && !s.dash)
            .sort((a, b) => {
                const rankOf = (s) => H264_CODECS.includes(String(s.codec || '').toLowerCase()) ? 0
                    : HEVC_CODECS.includes(String(s.codec || '').toLowerCase()) ? 1
                        : BYTEVC2_CODECS.includes(String(s.codec || '').toLowerCase()) ? 2 : 3;
                return rankOf(a) - rankOf(b) || Number(b.bitrate || 0) - Number(a.bitrate || 0);
            });
        const variants = streams.map(s => ({
            url: String(s.url || s.backup_url),
            contentKey: s.protected ? contentKeyHex : null,
            codec: normalizeCodec(s.codec),
            quality: String(s.definition || s.quality || (s.height ? `${s.height}p` : '')),
            ...(s.width && s.height ? { width: s.width, height: s.height } : {}),
            userAgent: STREAM_UA,
            source: 'openhongguo',
            vid: String(vid),
        })).filter(v => /^https?:\/\//.test(v.url));
        if (!variants.length) return null;
        logger.warn('Openhongguo', `兜底解析成功 vid=${vid}: 候选=${variants.length}, 编码=${variants[0].codec}, 加密=${playback.protected ? '是' : '否'}`);
        return {
            url: variants[0].url,
            contentKey: variants[0].contentKey,
            variants,
            duration: Number(playback.duration_seconds || 0),
            codec: variants[0].codec,
            quality: variants[0].quality,
        };
    } catch (error) {
        logger.warn('Openhongguo', `兜底解析未成功: ${error?.code || error?.name || ''} ${error?.message || error}`);
        return null;
    }
}

module.exports = { resolveViaOpenhongguo };
