/**
 * HEVC (H.265) 硬解能力探测（移植自 demo 客户端）：
 * 服务端取址需知道客户端能否直解 HEVC——不支持时流地址带 hevc=0，
 * 服务端优先返回 H264 片源或走 ffmpeg 转码兜底。
 */

let cachedSync: boolean | null = null;

/**
 * 同步探测：基于 canPlayType 的 HEVC 硬解支持初判（结果进程内缓存）。
 * @returns {boolean} canPlayType 对 hvc1/hev1 任一返回 probably/maybe 时为 true
 */
export function probeHevcSupportSync(): boolean {
  if (cachedSync !== null) return cachedSync;
  try {
    const v = document.createElement('video');
    cachedSync =
      v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '' ||
      v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== '';
  } catch {
    cachedSync = false;
  }
  return cachedSync;
}

/**
 * 异步校验：用 MediaCapabilities 精确验证 1080p HEVC 解码能力，
 * 与同步探测结果取交集（decodingInfo 明确 supported=false 时降级为不支持）。
 * @returns {Promise<boolean>} 最终 HEVC 支持结论
 */
export async function verifyHevcSupport(): Promise<boolean> {
  const sync = probeHevcSupportSync();
  if (!sync) return false;
  try {
    const media = navigator.mediaCapabilities;
    if (!media?.decodingInfo) return true;
    const info = await media.decodingInfo({
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
        width: 1920,
        height: 1080,
        bitrate: 2_000_000,
        framerate: 30,
      },
    });
    if (info.supported === false) return false;
  } catch {
    /* 探测失败保持同步探测结论 */
  }
  return true;
}
