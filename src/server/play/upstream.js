// SPDX-License-Identifier: GPL-3.0-only
// 上游取址编排：多端点阶梯 / 设备偏好路由 / 在途去重 / 缓存 / 三轮设备恢复阶梯。
// 迁移自 app-source.js（entryCache/preferredRoute/inFlight/buildPlaybackSteps/
// runPlaybackSteps/resolveUpstreamEntry），播放请求已切换至 v5 移动端签名。
const crypto = require('node:crypto');
const logger = require('../services/logger');
const { getPlaybackDevice, DEFAULT_VERIFIED_DEVICE } = require('../native/playback-device');
const loginState = require('../native/login-state');
const { deviceKey } = require('../native/device-session');
const { playbackRequestV5, videoTabRequest, shortplayRequest, SHORTPLAY_APIS } = require('./requests');
const { H264_CODECS, HEVC_CODECS, BYTEVC2_CODECS } = require('./entry');

// 播放端点阶梯（5 通道，按序尝试；偏好路由记忆该设备上次成功通道）
// PR#92：播放域主通道迁移至 reading.snssdk.com（multi_video_model/player/v1）
const VIDEO_APIS = [
    'https://reading.snssdk.com/novel/player/multi_video_model/player/v1',
    'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1',
    'https://api5-normal-lq.fqnovel.com/novel/player/multi_video_model/player/v1',
    'https://is.snssdk.com/novel/player/multi_video_model/player/v1',
    'https://api5-normal-hl.fqnovel.com/novel/player/multi_video_model/player/v1',
];

const entryCache = new Map();
// 设备偏好路由（该设备上次成功的通道类型+端点，下次直接首选）与取址并发去重
const preferredRouteByDevice = new Map();
const inFlightEntryRequests = new Map();
const SHORTPLAY_PREF_TTL_MS = 300000;
/** 新注册设备跨集群同步窗口：注册后 15s 内全空响应视为"同步未完成"，等待 1.5s 重试一轮 */
const FRESH_DEVICE_SYNC_WINDOW_MS = 15000;
const FRESH_DEVICE_RETRY_DELAY_MS = 1500;

/**
 * 清空取址缓存与在途请求。
 * @param {string} [vid] - 分集编号；省略时全量清空（同时重置设备偏好路由）
 * @returns {void}
 */
function clearEntryCache(vid) {
    if (vid) {
        const key = String(vid);
        entryCache.delete(key);
        inFlightEntryRequests.delete(key);
    } else {
        entryCache.clear();
        preferredRouteByDevice.clear();
        inFlightEntryRequests.clear();
    }
}

function sleepWithSignal(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function getPreferredRoute(devKey) {
    if (!devKey) return null;
    const pref = preferredRouteByDevice.get(devKey);
    if (!pref) return null;
    if (pref.expires && pref.expires <= Date.now()) {
        preferredRouteByDevice.delete(devKey);
        return null;
    }
    return pref;
}

function setPreferredRoute(devKey, kind, apiBase) {
    if (!devKey || !apiBase) return;
    preferredRouteByDevice.delete(devKey);
    preferredRouteByDevice.set(devKey, kind === 'shortplay'
        ? { kind, apiBase, expires: Date.now() + SHORTPLAY_PREF_TTL_MS }
        : { kind, apiBase });
    while (preferredRouteByDevice.size > 32) {
        preferredRouteByDevice.delete(preferredRouteByDevice.keys().next().value);
    }
}

/**
 * 构建设备的播放通道尝试序列（任务 63 风暴治理：每台设备最多 2 个端点）。
 * 偏好路由（该设备上次成功的通道）置顶，再补一个异构备通道（另一族端点的首个）；
 * 不再按 5 播放 + 3 短剧的全阶梯扫端点——空响应根因是设备/身份被风控标记，
 * 在同一设备上换端点只会烧请求配额（对齐 openhongguo：空响应即弃用设备）。
 * @param {string} devKey - 设备键（device_id）
 * @returns {{kind: 'multi'|'shortplay', apiBase: string}[]} 有序尝试步骤（长度 ≤ 2）
 */
function buildPlaybackSteps(devKey) {
    const pref = getPreferredRoute(devKey);
    const multiPrimary = pref?.kind === 'multi' && VIDEO_APIS.includes(pref.apiBase) ? pref.apiBase : VIDEO_APIS[0];
    const shortPrimary = pref?.kind === 'shortplay' && SHORTPLAY_APIS.includes(pref.apiBase) ? pref.apiBase : SHORTPLAY_APIS[0];
    if (pref?.kind === 'shortplay') {
        return [{ kind: 'shortplay', apiBase: pref.apiBase }, { kind: 'multi', apiBase: VIDEO_APIS[0] }];
    }
    return [{ kind: 'multi', apiBase: multiPrimary }, { kind: 'shortplay', apiBase: shortPrimary }];
}

/** 响应批量写入取址缓存（3 分钟 TTL，容量 64，与 demo cacheResponseEntries 一致） */
function cacheResponseEntries(response) {
    // data["1004"] 嵌套结构兼容（参考 hongguoTV MobilePlayback.kt entries 取值，
    // `data["1004"] || data` 两种形态都支持）
    const data = response?.data?.['1004'] || response?.data;
    if (data && typeof data === 'object') {
        const now = Date.now();
        for (const [id, entry] of Object.entries(data)) {
            if (entry && (entry.video_model || entry.fallback_api)) {
                entryCache.set(id, { entry, expires: now + 180000 });
            }
        }
        while (entryCache.size > 64) {
            entryCache.delete(entryCache.keys().next().value);
        }
    }
}

/**
 * 统一降级循环（demo 重构 + 任务 63 风暴治理收敛）：
 * - 播放通道业务拒绝（BUSINESS_REJECTED）直接上抛终止阶梯；
 * - 业务码 10001/10002/110001（设备身份被上游拒绝，参考 14771e0 DeviceRejectedException）
 *   抛 DEVICE_REJECTED 交由上层标记失败并走阶梯下一轮换设备；
 * - 上游显式限流（RATE_LIMITED，参考 478f006 Retry-After 判定）直接上抛终止本轮，
 *   不换端点、不换设备、不烧注册配额；
 * - 空响应立即终止本设备全部通道（设备身份已被风控标记，换端点无效，
 *   返回 allEmpty=true 交由上层换设备，对齐 openhongguo 空响应即弃用设备）；
 * - 网络类错误（非空响应）最多换一次异构端点重试（不同域名族）；
 * 步骤序列由 buildPlaybackSteps 提供（≤2 步），单设备请求量上限 2。
 * @param {{kind: string, apiBase: string}[]} steps - 通道尝试序列
 * @param {string} vid - 分集编号
 * @param {string} payload - 播放业务 JSON 请求体（明文）
 * @param {Object} device - 设备身份
 * @param {Function} execRequestJson - 传输层执行器（requestJson 包装，附诊断字段）
 * @param {number} deadline - 取址截止时间戳（毫秒）
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<{response: Object|null, lastError: Error|null, allEmpty: boolean}>} 取址结果
 */
async function runPlaybackSteps(steps, vid, payload, device, execRequestJson, deadline, signal) {
    const devKey = deviceKey(device);
    let lastError = null;
    let allEmpty = true;
    let skipRemainingMulti = false;
    let loggedMultiRetry = false;
    let loggedShortplay = false;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.kind === 'multi' && skipRemainingMulti) continue;
        signal.throwIfAborted();
        if (deadline - Date.now() <= 0) break;

        try {
            if (step.kind === 'multi') {
                const signed = playbackRequestV5(payload, device, step.apiBase);
                const resp = await execRequestJson(signed.url, { method: 'POST', headers: signed.headers, data: signed.body }, deadline, signal);
                const bizCode = Number(resp?.Code || resp?.code || 0);
                if (bizCode !== 0) {
                    // 业务码设备拒绝（参考 14771e0：10001/10002/110001 为身份过期标志）；
                    // 设备失败计数由传输层 recordResponse（BUSINESS_REJECTED）完成
                    if (bizCode === 10001 || bizCode === 10002 || bizCode === 110001) {
                        throw Object.assign(new Error('播放接口拒绝该设备身份'), { code: 'DEVICE_REJECTED', bizCode });
                    }
                    throw Object.assign(new Error('App 接口暂未提供本集播放信息'), { code: 'BUSINESS_REJECTED' });
                }
                cacheResponseEntries(resp);
                const dataEntries = resp?.data?.['1004'] || resp?.data;
                const hasEntry = Boolean(dataEntries?.[vid] || entryCache.get(vid)?.entry);
                if (hasEntry) setPreferredRoute(devKey, 'multi', step.apiBase);
                return { response: resp, allEmpty: false };
            }

            const shortSigned = shortplayRequest(vid, device, step.apiBase);
            const shortResp = await execRequestJson(shortSigned.url, { method: 'POST', headers: shortSigned.headers, data: shortSigned.body }, deadline, signal);
            const entry = shortResp?.data?.[vid] || (shortResp?.data?.video_model ? shortResp.data : null);
            if (entry) {
                const resp = { code: 0, data: { [vid]: entry } };
                cacheResponseEntries(resp);
                setPreferredRoute(devKey, 'shortplay', step.apiBase);
                return { response: resp, allEmpty: false };
            }
            allEmpty = false;
        } catch (err) {
            signal.throwIfAborted();
            if (err.code === 'BUSINESS_REJECTED' || err.code === 'DEVICE_REJECTED') throw err;
            // 上游显式限流（Retry-After）：直接终止本轮，不换端点不换设备（参考 478f006）
            if (err.code === 'RATE_LIMITED') throw err;
            lastError = err;
            if (err.code !== 'EMPTY_RESPONSE') {
                allEmpty = false;
                if (step.kind === 'multi') skipRemainingMulti = true;
            }
            const nextStep = steps.slice(i + 1).find(candidate => !(candidate.kind === 'multi' && skipRemainingMulti));
            if (nextStep?.kind === 'multi' && err.code === 'EMPTY_RESPONSE' && !loggedMultiRetry) {
                loggedMultiRetry = true;
                logger.warn('AppSource', '播放接口返回空响应，尝试备用接口重试...');
            } else if (nextStep?.kind === 'shortplay' && !loggedShortplay) {
                loggedShortplay = true;
                logger.warn('AppSource', '红果接口受阻，降级至番茄小说短剧备用通道...');
            }
            // 任务 63：空响应 → 设备已被标记，立即终止本设备剩余端点（不再烧请求）
            if (err.code === 'EMPTY_RESPONSE') return { response: null, lastError, allEmpty: true };
        }
    }
    return { response: null, lastError, allEmpty };
}

/**
 * video_tab 同身份兜底（参考 hongguoTV 478f006 tabVideoModel strict 形态）：
 * v5 播放元数据偶发"空 200"时，用当前注册身份对 video_tab 接口 GET 重查一次当前集；
 * video_id 参数严格精确匹配当前集（不取他集），取响应 data.video_model_data[id].video_model
 * （兼容 data["1004"] 嵌套与 data 直挂两种形态）。成功时包装为播放阶梯统一响应形态，
 * 失败（网络/业务码/结构不符）返回 null，由调用方继续走原有设备阶梯；
 * 上游显式限流（RATE_LIMITED，即响应带 Retry-After）原样上抛终止本轮。
 * @param {string} vid - 当前分集编号（严格精确匹配）
 * @param {Object} device - 当前注册设备身份（同身份重查，不重新注册）
 * @param {Function} execRequestJson - 传输层执行器（requestJson 包装，附诊断字段）
 * @param {number} deadline - 取址截止时间戳（毫秒）
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<Object|null>} 兜底成功返回 { code: 0, data: { [vid]: { video_model } } }，失败返回 null
 * @throws {Error} 上游显式限流（RATE_LIMITED）时上抛
 */
async function tryVideoTabFallback(vid, device, execRequestJson, deadline, signal) {
    try {
        const signed = videoTabRequest(vid, device);
        const resp = await execRequestJson(signed.url, { method: 'GET', headers: signed.headers }, deadline, signal);
        if (Number(resp?.Code || resp?.code || 0) !== 0) return null;
        const data = resp?.data?.video_model_data || resp?.data?.['1004'] || resp?.data;
        const model = data?.[vid]?.video_model;
        if (!model) return null;
        return { code: 0, data: { [vid]: { video_model: model } } };
    } catch (err) {
        if (err.code === 'RATE_LIMITED') throw err;
        logger.warn('AppSource', `video_tab 同身份兜底未取到当前集（${err?.code || err?.message || '未知错误'}），继续设备阶梯...`);
        return null;
    }
}

/**
 * 判断分集条目的 video_model 是否为 ByteVC2 编码专属：
 * 含 ByteVC2 档位且无任何 H264 / HEVC 档位（fallback_api 外链形态编码未知，不判定）。
 * @param {Object} entry - 上游分集条目（含 video_model）
 * @returns {boolean} ByteVC2 专属返回 true
 */
function isBytevc2OnlyModel(entry) {
    try {
        const raw = entry?.video_model;
        const model = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const list = Array.isArray(model?.video_list) ? Object.values(model.video_list) : [];
        const codecs = list.map(item => String(item?.codec_type || item?.video_meta?.codec_type || '').toLowerCase());
        if (!codecs.length) return false;
        return codecs.some(codec => BYTEVC2_CODECS.includes(codec))
            && !codecs.some(codec => H264_CODECS.includes(codec) || HEVC_CODECS.includes(codec));
    } catch {
        return false;
    }
}

/**
 * ByteVC2 专属兜底重取（参考 hongguoTV ac3a1e2e / v0.16.13）：
 * video_tab 兜底常返回 ByteVC2 专属编码模型（电视端无法解码）；桌面端虽有 ffmpeg 转码
 * 通道但成本高——此场景下用同身份对备用域名（sinfonlineb，播放域未用过的集群）重取一次
 * 移动端 multi_video_model，若返回含 H264/HEVC 可直解/硬解档位的条目则替代使用；
 * 失败（网络/业务码/结构不符/仍为 ByteVC2 专属）返回 null 沿用 video_tab 模型。
 * 任务 63 风暴治理约束：仅在"阶梯全空 + video_tab 兜底且 ByteVC2 专属"的窄场景多 1 个请求。
 * @param {string} vid - 当前分集编号
 * @param {string} payload - 播放业务 JSON 请求体（与主阶梯一致）
 * @param {Object} device - 当前注册设备身份
 * @param {Function} execRequestJson - 传输层执行器
 * @param {number} deadline - 取址截止时间戳（毫秒）
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<Object|null>} 重取成功返回播放阶梯统一响应形态，失败返回 null
 * @throws {Error} 上游显式限流（RATE_LIMITED）时上抛
 */
async function retryMultiModelAlternateHost(vid, payload, device, execRequestJson, deadline, signal) {
    try {
        const signed = playbackRequestV5(payload, device,
            'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1');
        const resp = await execRequestJson(signed.url, { method: 'POST', headers: signed.headers, data: signed.body }, deadline, signal);
        if (Number(resp?.Code || resp?.code || 0) !== 0) return null;
        const dataEntries = resp?.data?.['1004'] || resp?.data;
        const entry = dataEntries?.[vid];
        if (!entry?.video_model || isBytevc2OnlyModel(entry)) return null;
        logger.info('AppSource', '备用域名重取到含 H264/HEVC 档位的模型，替代 video_tab 的 ByteVC2 专属模型');
        return resp;
    } catch (err) {
        if (err.code === 'RATE_LIMITED') throw err;
        logger.warn('AppSource', `备用域名重取未取到兼容模型（${err?.code || err?.message || '未知错误'}），沿用 video_tab 模型...`);
        return null;
    }
}

/** 等待在途取址任务完成（跟随调用方 signal 中止；最后一个等待者被中止时取消任务本身） */
function waitForInFlightEntry(job, signal) {
    if (!signal) return job.promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    const waiter = Symbol();
    job.waiters.add(waiter);
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
            job.waiters.delete(waiter);
        };
        const onAbort = () => {
            cleanup();
            if (!job.waiters.size) job.controller.abort(signal.reason);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        job.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

/** 当前设备是否已成功取到过播放地址（设备健康度）。
 *  空响应多数是服务端对当前设备身份的静默拒绝（内置基准设备为公开共享身份，易被标记）；
 *  降级链终局会注册全新匿名设备重试（实测可恢复）。
 *  设备一旦验证可用，同进程内的空响应仍优先按风控窗口处理——同设备重试收敛，
 *  避免每次失败都消耗注册配额；熔断器与用户手动「重置设备」兜底。 */
let deviceProvenGood = false;

/**
 * 上游取址（含在途去重与本地自研终局恢复阶梯）：
 * 同 vid 的并发取址共享同一次上游请求（调用方中止传播由 waitForInFlightEntry 处理）；
 * 强制刷新（refresh=true）清缓存与在途任务后重建。
 * 任务内部阶梯（本机自研，叠加于多端点阶梯之上）：
 * ① 当前设备全阶梯（空响应时叠加 video_tab 同身份 GET 兜底一次，参考 478f006）
 * → ② 新注册设备同步窗口重试 → ③ 非基准设备切基准重试（任务 53）
 * → ④ 注册全新匿名设备重试（任务 53 实测可恢复）。
 * 业务码 10001/10002/110001（参考 14771e0）视为设备身份被拒，走阶梯下一轮换设备；
 * 上游显式限流（Retry-After，参考 478f006）直接终止本轮，不换设备不烧注册配额。
 * @param {string} vid - 分集编号
 * @param {string[]} batch - 本次批量取址的分集编号列表（首元素为 vid）
 * @param {boolean} refresh - 是否强制刷新（绕过缓存与在途共享）
 * @param {AbortSignal} callerSignal - 调用方中止信号
 * @returns {Promise<Object>} 上游分集条目（含 video_model）
 * @throws {Error} 三轮设备阶梯耗尽后上抛 lastError 或 MISSING_MODEL
 */
async function resolveUpstreamEntry(vid, batch, refresh, callerSignal) {
    if (refresh) {
        entryCache.delete(vid);
        inFlightEntryRequests.delete(vid);
    } else if (inFlightEntryRequests.has(vid)) {
        return await waitForInFlightEntry(inFlightEntryRequests.get(vid), callerSignal);
    }

    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(12000);
    const internalSignal = AbortSignal.any([timeoutSignal, controller.signal]);
    const deadline = Date.now() + 12000;

    const job = { controller, waiters: new Set(), promise: null };
    job.promise = (async () => {
        // PR#106：payload 变更——device_level 3→1、新增 disable_video_relate_book:false、
        // dr_scene:'player' 移至末尾（对照官方 v04.10.03 客户端抓包）
        const payload = JSON.stringify({
            biz_param: { detail_page_version: 0, device_level: 1, disable_digg_stat: false, disable_video_relate_book: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
            mixed_video_id_map: { '1004': batch },
            dr_scene: 'player',
        });
        const playbackId = crypto.randomUUID();
        // 传输层（requestJson）留在 app-source：设备会话注入/Cookie 合并对全接口统一生效
        const { requestJson, runWarmup } = require('../native/app-source');
        const execRequestJson = (url, requestOptions, ...args) => requestJson(url,
            { ...requestOptions, diagnostics: { playback_id: playbackId, vid } }, ...args);
        const device = await getPlaybackDevice(execRequestJson, internalSignal);
        // 新注册的匿名设备异步预热（本机自研；登录态/基准设备/已验证设备无需预热）
        if (!loginState.hasToken() && !deviceProvenGood && !getPlaybackDevice.currentProvenGood?.()
            && device?.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
            void runWarmup(device);
        }

        // 单设备的通道尝试（≤2 请求）；新注册设备（15s 内）空响应时按同步窗口
        // 逻辑等待 1.5s 后仅重试主端点一次（任务 63：不再重跑全阶梯）
        const runDeviceSteps = async (dev, { singleStep = false, syncRetry = true } = {}) => {
            const allSteps = buildPlaybackSteps(deviceKey(dev));
            const steps = singleStep ? allSteps.slice(0, 1) : allSteps;
            let result = await runPlaybackSteps(steps, vid, payload, dev, execRequestJson, deadline, internalSignal);
            if (!result.response && result.allEmpty && syncRetry && dev?.created_at
                && (Date.now() - dev.created_at < FRESH_DEVICE_SYNC_WINDOW_MS)
                && (deadline - Date.now() > FRESH_DEVICE_RETRY_DELAY_MS + 1000)) {
                logger.info('AppSource', `新设备刚完成注册可能仍在跨集群同步中，等待 ${FRESH_DEVICE_RETRY_DELAY_MS}ms 后重试主端点...`);
                await sleepWithSignal(FRESH_DEVICE_RETRY_DELAY_MS, internalSignal);
                result = await runPlaybackSteps(allSteps.slice(0, 1), vid, payload, dev, execRequestJson, deadline, internalSignal);
            }
            return result;
        };

        // 空响应诊断字段（本机自研）：bytes/logid/设备后四位/机型，一行日志定位拒绝层
        const diag = (err) => [err.bytes != null ? `bytes=${err.bytes}` : '', err.logid ? `logid=${err.logid}` : '',
            `iid=…${String(device.iid).slice(-4)}`, device.profile?.model ? `model=${device.profile.model}` : ''].filter(Boolean).join(', ');

        let result = null;
        try {
            result = await runDeviceSteps(device);
        } catch (err) {
            if (err.code !== 'DEVICE_REJECTED') throw err;
            // 业务码 10001/10002/110001（参考 14771e0 DeviceRejectedException）：当前设备
            // 身份被上游拒绝 → 标记失败（传输层 recordResponse 已计入 consecutive_failures）
            // 并走阶梯下一轮换设备重试；防循环沿用既有 RESET_COOLDOWN/注册失败冷却与
            // 单轮注册上限，不另设新冷却
            logger.warn('AppSource', `播放接口业务码 ${err.bizCode} 拒绝当前设备身份，切换设备重试... [iid=…${String(device.iid).slice(-4)}]`);
            result = { response: null, allEmpty: true, lastError: err };
        }
        // video_tab 同身份兜底（参考 478f006）：首轮阶梯空响应时，先用当前注册身份
        // GET 重查一次当前集；限流（RATE_LIMITED）已在上方抛出不会进入本兜底；
        // 兜底失败（返回 null）则继续走原有设备阶梯
        if (!result.response && result.allEmpty) {
            const tabResp = await tryVideoTabFallback(vid, device, execRequestJson, deadline, internalSignal);
            if (tabResp) {
                // ByteVC2 专属兜底重取（参考 ac3a1e2e / v0.16.13）：tab 模型仅含 ByteVC2 时，
                // 同身份对备用域名重取一次移动端模型；成功则替代，失败沿用 tab 模型
                //（桌面端仍可 ffmpeg 转码 ByteVC2，不因重取失败而失去兜底）
                let finalResp = tabResp;
                const tabEntry = tabResp.data?.[vid];
                if (isBytevc2OnlyModel(tabEntry)) {
                    const altResp = await retryMultiModelAlternateHost(vid, payload, device, execRequestJson, deadline, internalSignal);
                    if (altResp) finalResp = altResp;
                }
                cacheResponseEntries(finalResp);
                result = { response: finalResp, allEmpty: false };
            }
        }
        if (!result.response && result.allEmpty && typeof getPlaybackDevice.fallbackToDefault === 'function'
            && DEFAULT_VERIFIED_DEVICE && device?.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
            // 任务 53：全部通道空响应且当前设备非基准设备 → 切内置基准设备重试（不消耗注册配额）；
            // 任务 63：基准设备只试主端点一次（基准身份大概率同样被标记，不值得多烧请求）
            logger.warn('AppSource', `播放通道空响应，切换至基准设备重试... [${diag(result.lastError || {})}]`);
            result = await runDeviceSteps(getPlaybackDevice.fallbackToDefault(), { singleStep: true, syncRetry: false });
        }
        if (!result.response && result.allEmpty) {
            // 任务 53：终局恢复——注册全新匿名设备再试一轮（实测可恢复）。
            // 任务 63：换机上限于 2 台（对齐 openhongguo defaultDeviceResets=2），
            // 当前设备 + 基准设备已构成 2 轮，注册新设备为最后一轮；仍空响应则直接报错，
            // 不再无限轮换烧注册配额与请求量。
            let fresh = null;
            try {
                fresh = await getPlaybackDevice.rotateDevice(execRequestJson, internalSignal);
                logger.warn('AppSource', `播放通道空响应，已注册全新匿名设备重试: device_id=…${String(fresh.device_id).slice(-6)}, model=${fresh.profile?.model ?? '-'}`);
            } catch { /* 注册失败（网络/冷却）不阻塞错误上抛 */ }
            if (fresh) result = await runDeviceSteps(fresh);
        }
        if (!result.response) {
            throw result.lastError || Object.assign(new Error('App 接口未返回所选分集，已停止取址'), { code: 'MISSING_MODEL' });
        }
        // 取址成功：当前设备验证可用（此后空响应按 IP 风控窗口处理，不再换设备）；
        // 同时持久化健康度时间戳，下次进程重启复用设备时同样受护栏保护（本机自研）
        deviceProvenGood = true;
        getPlaybackDevice.markDeviceGood?.();
        // data["1004"] 嵌套结构兼容（参考 MobilePlayback.kt entries 取值）
        const dataEntries = result.response.data?.['1004'] || result.response.data;
        const currentEntry = dataEntries?.[vid] || entryCache.get(vid)?.entry;
        if (!currentEntry) throw Object.assign(new Error('App 接口未返回所选分集，已停止取址'), { code: 'MISSING_MODEL' });
        return currentEntry;
    })().finally(() => {
        if (inFlightEntryRequests.get(vid) === job) inFlightEntryRequests.delete(vid);
    });

    inFlightEntryRequests.set(vid, job);
    return await waitForInFlightEntry(job, callerSignal);
}

module.exports = { resolveUpstreamEntry, clearEntryCache, buildPlaybackSteps, entryCache };
