# src/server/play — 播放地址获取模块

> 职责边界：**只负责播放地址（片源 URL + 内容密钥）的获取与解析**。
> 搜索/目录/元数据/登录/弹幕等域的 v3 签名与传输层仍在 [app-source.js](../native/app-source.js)；
> 本模块对播放域按参考项目 PR#106（commit 48f956f）切换至 **v04.10.03 移动端签名机制（v5）**。

## 文件结构

| 文件 | 职责 |
|---|---|
| [index.js](./index.js) | 对外门面：`fetchAppPlayUrl`（取址入口，熔断 + 并发去重 + openhongguo 兜底）、`clearEntryCache`、`isHevcCodec` |
| [upstream.js](./upstream.js) | 上游取址编排：端点阶梯、设备偏好路由、在途去重、取址缓存、三轮设备恢复阶梯、v5 业务 payload |
| [requests.js](./requests.js) | 请求构造：`playbackRequestV5`（v5 签名播放请求）、`shortplayRequest`（番茄短剧降级，仍走 v3 PlayerSigner） |
| [v5-sign.js](./v5-sign.js) | v5 加密算法核心：`hashF13V5` / `AesV3V5` / `medusaV5` / `heliosV5` / `signPlaybackV5`（移植自 N3urda/hongguoTV，GPL-3.0-only） |
| [entry.js](./entry.js) | 片源解析：spade_a 密钥派生、spade URL 解密（AES-128-CBC）、地址安全校验、codec 分级（HEVC 感知）、`parseEntryPlayInfo` |
| [util.js](./util.js) | 共享工具：URL 编码、UA 构建、片源域白名单校验（app-source 也复用其中部分） |

对外导出名（`fetchAppPlayUrl` / `clearEntryCache` / `isHevcCodec` / `shortplayRequest`）经
app-source.js 按原名转发，streamService / hongguo / danmaku 等既有调用方零改动。

## v5 签名机制（加密算法更新，PR#106）

### 为什么换签名

旧 v3 medusa 签名被当前播放端点（`/novel/player/multi_video_model/player/v1`）以
**200 + 空 body** 静默拒绝——这正是本项目"全端点空响应"的解药。v5 机制下：

- 请求头只发 `x-khronos` / `x-helios` / `x-medusa` / `x-ss-stub` / `Content-Type`
  （**不再有** `x-argus` / `x-ladon` / `x-gorgon` / `x-ss-req-ticket`）；
- 搜索/目录/详情域仍用旧 v3 签名（v5 仅限播放端点）。

### 请求形态（固定指纹）

v5 将官方客户端指纹固定写入 query 与 medusa 明文，注册设备的三要素
（`iid` / `cdid` / `device_id`）同时绑定进两者：

```
query 固定参数：aid=8662  app_name=novelread  version_code=74332  version_name=7.4.3.32
              channel=vivo_8662_64  device_platform=android  device_type=PGT-AN10
              os_version=12  update_version_code=74332  + 三要素 + _rticket
UA 固定：com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)
```

### 业务 payload 变更

`dr_scene:'player'` 移至末尾；`device_level: 3 → 1`；新增 `disable_video_relate_book: false`。

### 签名算法要点（v5-sign.js）

| 组件 | 说明 |
|---|---|
| 分支选择 | `branchV5`：`iv = getIv(getIv(getIv(0x20230928, sm3(query)), md5(body)), le32(ts))` 取低 4 位，v5 要求**恰为 12**（v3 要求 `%3 == 0`）。通过搜索 `_rticket` 偏移（0..1023）使 query 命中该分支 |
| `hashF13V5` | 协议特定哈希（仅实现 branch 12）：固定种子 `0x9d4a97c2`、选位 `(1,3,4,0,6,5,2,0,7,7)`、96 轮状态混淆，输出 20 字节（折叠 16 + 校验位，bit 5 置位） |
| `AesV3V5` | 非标准 AES 的**时限参数化**分组密码：按 `ts & 3` 从 1024 字节 S-box 取片段，选列置换/字节位序/初始常量；按 bit 打包（wire/compact 位序）做 CBC 风格两轮 block 变换 |
| `medusaV5` | protobuf 消息（magic/license/设备身份/hashF13/环境）→ `xmxor` 自定义置换 → 反转 + seed 异或 → `0xca` 头 packed → `AesV3V5` 加密 → base64 |
| `heliosV5` | 34 轮 ARX（64 位分组，`ror 61`）加密 `<ts>-646637794-8662` license 串 |

正确性由官方测试向量逐字节验证（4 条 AesV3V5 载体向量 + 32 条 hashF13V5 摘要向量）：

```bash
node --test test/unit/v5-sign.test.js
```

## 取址流程与风暴治理（任务 63 设计，全部保留）

```
fetchAppPlayUrl(vid)
  ├─ 熔断检查（60s 内 ≥5 次服务端拒绝 → 45s 快速失败 RATE_LIMITED）
  ├─ 同 vid 并发去重（StrictMode 双挂载 / 双击只发一次）
  ├─ 缓存命中（3min TTL）→ 直接解析片源
  └─ resolveUpstreamEntry（三轮设备阶梯，换机 ≤2 台）
       ├─ ① 当前设备：buildPlaybackSteps ≤2 端点（偏好路由置顶 + 1 异构备通道）
       ├─ 新设备注册 15s 内空响应 → 等 1.5s 仅重试主端点一次
       ├─ ② 空响应 → 切基准设备（单端点 1 请求，不消耗注册配额）
       ├─ ③ 仍空响应 → 注册全新匿名设备重试（终局）
       └─ 全空 → openhongguo SDK 兜底一次（仅 EMPTY_RESPONSE/MISSING_MODEL）
            └─ 失败 → 上抛原错误（熔断器记账）
```

- **空响应即弃用设备**（对齐 openhongguo）：设备身份被风控标记时换端点无效，
  `runPlaybackSteps` 收到 EMPTY_RESPONSE 立即终止本设备剩余端点；
- 单次播放最坏请求量 ≤7（正常首端点命中仅 1 次；缓存命中 0 次）；
- 偏好路由：设备上次成功通道（multi/shortplay）下次置顶；短剧偏好 5min TTL。

## 番茄短剧降级通道

红果播放域全受阻时，`buildPlaybackSteps` 的异构备通道走番茄小说客户端短剧接口
（aid 1967，`/novel/player/video_model/v1/`，仍用 v3 PlayerSigner 签名）。

## 依赖关系

```
app-source.js ──require──> play/index.js ──> upstream.js ──> requests.js ──> v5-sign.js
     ▲                          │                │
     └──── requestJson / runWarmup（懒 require，避免循环加载）      └──> ../native/playback-device（设备身份）
```

- 传输层 `requestJson` 留在 app-source（设备会话 Jar 注入 / Cookie 合并对全接口统一生效）；
- 设备身份（指纹池 / 健康度 / 注册 / 冷却 / CookieJar 会话）仍在 `../native/playback-device.js`；
- HEVC 客户端能力（硬解探测 / ffmpeg 转码兜底）由渲染层探测后经
  `fetchAppPlayUrl` 选项透传（`allowHevc` / `allowHevcTranscode` / `allowBytevc2`）。
