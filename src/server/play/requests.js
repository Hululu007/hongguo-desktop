// SPDX-License-Identifier: GPL-3.0-only
// 播放域请求构造：v5 移动端签名播放请求 + 番茄短剧降级请求。
// 迁移自 app-source.js（playbackRequest/shortplayRequest），并按参考项目
// zfdang/hongguo-open-player PR#106（commit 48f956f）切换至 v5 签名机制。
const { gzipSync } = require('node:zlib');
const loginState = require('../native/login-state');
const { PlayerSigner } = require('../native/argus');
const { signPlaybackV5 } = require('./v5-sign');
const { pythonUrlEncode } = require('./util');

// v5 播放 query 固定参数：官方 7.4.3.32 vivo 渠道 + PGT-AN10 机型
// （对照 hongguoTV MobilePlayback.kt；设备三要素 iid/cdid/device_id 由注册身份注入）
const V5_PLAYBACK_QUERY = {
    aid: '8662', app_name: 'novelread', version_code: '74332', version_name: '7.4.3.32',
    channel: 'vivo_8662_64', device_platform: 'android', device_type: 'PGT-AN10',
    os_version: '12', update_version_code: '74332',
};
// v5 播放 UA 固定为官方 7.3.9.32 PGT-AN10 档（与 query device_type 同源，指纹一致）
const V5_PLAYBACK_UA = 'com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)';

// 番茄小说客户端短剧接口（aid 1967）：红果播放域全受阻时的降级通道
const SHORTPLAY_APIS = [
    'https://api3-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/',
    'https://api5-normal-lq.fqnovel.com/novel/player/video_model/v1/',
    'https://reading.snssdk.com/novel/player/video_model/v1/',
];
const SHORTPLAY_API = SHORTPLAY_APIS[0];

/**
 * 构造 v5 移动端签名的播放域请求（v04.10.03 机制，PR#106）。
 * v3 medusa 被当前播放端点以空 200 拒绝；v5 将注册设备三要素同时绑定进
 * query 与 medusa 明文，请求头只发 x-khronos/x-helios/x-medusa/x-ss-stub/Content-Type
 * （不再有 x-argus/x-ladon/x-gorgon/x-ss-req-ticket）。
 * Cookie 仍由本函数合并（设备 Cookie + 用户登录态），设备会话 Jar 的注入由传输层完成。
 * @param {string} payload - 业务 JSON 请求体（明文，函数内部 gzip）
 * @param {{device_id?: string, iid?: string, cdid?: string, cookie?: string}} identity - 注册设备身份（仅取三要素与 Cookie，会话/诊断字段不得进 query）
 * @param {string} apiBase - 播放端点（多端点阶梯中的一条）
 * @returns {{url: string, body: Buffer, headers: Object<string,string>}} 签名后请求
 */
function playbackRequestV5(payload, identity, apiBase) {
    const body = gzipSync(Buffer.from(payload));
    const { device_id = '', iid = '', cdid = '' } = identity || {};
    const values = {
        ...V5_PLAYBACK_QUERY,
        iid: iid || '', cdid: cdid || '', device_id: device_id || '',
    };
    const { url, headers: signedHeaders } = signPlaybackV5(apiBase, values, body);
    const headers = {
        'User-Agent': V5_PLAYBACK_UA, Accept: 'application/json',
        'Content-Encoding': 'gzip',
        ...signedHeaders,
    };
    // 设备 Cookie：注册时捕获的 set-cookie（无则按 install_id 兜底）；
    // 登录态请求头（x-tt-token / 用户 Cookie）合并在后（任务 26 本机增强）
    const cookieHeader = identity?.cookie || (iid ? `store-region=cn-bj; store-region-src=did; install_id=${iid}` : '');
    const authHeaders = loginState.authHeaders();
    if (cookieHeader || authHeaders.Cookie) {
        headers.Cookie = [cookieHeader, authHeaders.Cookie].filter(Boolean).join('; ');
    }
    return { url, body, headers };
}

/**
 * 构造番茄小说短剧降级请求（aid 1967，PlayerSigner v3 签名，对照 demo PR#92）。
 * 红果播放域通道与设备全部受阻时的降级通道（buildPlaybackSteps 异构备通道）。
 * @param {string} vid - 分集编号
 * @param {{device_id?: string, iid?: string, cdid?: string, cookie?: string}} identity - 设备身份（仅取三要素与 Cookie）
 * @param {string} [apiBase] - 短剧端点（默认主通道）
 * @returns {{url: string, body: Buffer, headers: Object<string,string>}} 签名后请求
 */
function shortplayRequest(vid, identity, apiBase = SHORTPLAY_API) {
    const { profile: _omitProfile, ...ids } = identity || {};
    const khronos = Math.floor(Date.now() / 1000);
    const query = pythonUrlEncode({
        iid: ids.iid || '',
        device_id: ids.device_id || '',
        aid: '1967',
        app_name: 'novelapp',
        version_code: '72132',
        version_name: '7.2.1.32',
        device_platform: 'android',
        device_brand: 'Xiaomi',
        os_version: '13',
        cdid: ids.cdid || '',
    });
    const url = `${apiBase}?${query}`;
    const payload = JSON.stringify({
        video_id: String(vid),
        content_type: 1004,
        biz_param: {
            detail_page_version: 0, device_level: 3, disable_digg_stat: false, disable_video_relate_book: false,
            from_video_id: '', need_all_video_definition: true, need_mp4_align: false, source: 4,
            use_os_player: false, use_server_dns: false, video_platform: 3,
        },
    });
    const body = Buffer.from(payload);
    const signerHeaders = PlayerSigner.headers(query, body, khronos);
    const headers = {
        'User-Agent': 'com.dragon.read',
        'Content-Type': 'application/json; charset=utf-8',
        ...signerHeaders,
    };
    const cookieHeader = ids.cookie || (ids.iid ? `store-region=cn-bj; store-region-src=did; install_id=${ids.iid}` : '');
    if (cookieHeader) headers.Cookie = cookieHeader;
    return { url, body, headers };
}

module.exports = { playbackRequestV5, shortplayRequest, V5_PLAYBACK_QUERY, V5_PLAYBACK_UA, SHORTPLAY_APIS, SHORTPLAY_API };
