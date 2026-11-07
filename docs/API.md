# XlikeMind API 与消息说明

本文记录 v0.1.0 的本地数据边界、Chrome 扩展内部消息和 OpenAI-compatible AI 请求格式。XlikeMind 没有开发者后端，也没有对外提供 HTTP API；下面的 Chrome 消息属于实现接口，可能随扩展版本变化，不是稳定的第三方 SDK。

## 1. 数据与网络边界

```text
X content script ── Chrome message / Port ──> service worker
       │                                      │
       └───────────── 可见页面数据 ────────────┘
                                              ▼
                                  IndexedDB（当前本地档案）
                                              │
                         ┌────────────────────┴──────────────────┐
                         ▼                                       ▼
                 Popup / Dashboard                    ZIP 或本地目录 index.html
```

- 帖子、媒体、任务、人工修订和 AI 结果保存在当前 Chrome 扩展的 IndexedDB；设置保存在 Chrome storage。
- 每个本地档案有独立的数据空间。同步消息必须携带或继承 `profileId`，不能根据帖子作者猜测档案。
- 采集只读取用户当前打开的 X 页面可见内容。缺席不等于取消喜欢，未知的 `likedAt` 保持 `null`。
- 导出是用户主动操作，媒体在包内使用相对路径；没有远程索引服务。
- AI 请求是唯一的可选外部内容处理路径。它使用用户配置的 endpoint，并通过 `fetch` 发送 `credentials: omit` 的 JSON 请求。

## 2. 核心数据形状

### `NormalizedPost`

```ts
interface NormalizedPost {
  id: string;                 // 稳定本地主键，例如 x:<post-id>
  platform: 'x';
  postId: string;
  canonicalUrl: string;
  author?: {
    handle?: string;
    displayName?: string;
    id?: string;
    avatarUrl?: string;
  };
  text: string;               // 原文，不被 AI 结果覆盖
  postedAt: string | null;
  likedAt: string | null;     // 无真实来源时为 null
  firstObservedAt: string;
  lastObservedAt: string;
  captureStatus: 'complete' | 'partial' | 'failed';
  missingFields: string[];
  externalLinks: string[];
  mediaIds: string[];
  contentHash: string;
  sourceAdapter: string;
  sources?: ('x_likes' | 'x_bookmarks' | 'x_archive')[];
  sourceRunId: string;
  schemaVersion: number;
}
```

`MediaAsset` 包含 `id`、`postId`、`position`、`kind`、`sourceUrl`、`status` 和可选的本地 Blob。`status` 为 `pending`、`downloaded`、`failed` 或 `remote_only`。导出器按 `position` 保留图片顺序；不可下载的媒体会留在失败或远程链接清单中。

## 3. Service Worker 同步消息

内容脚本通过 `chrome.runtime.connect({ name: 'xlike-sync' })` 连接 Service Worker。实现中的 `syncClient` 会为每个请求加入数字 `requestId`，后台在响应中原样带回。一次性 `sendMessage` 不是保存批次的传输方式。

### `BEGIN_X_SYNC`

开始或恢复一个有界同步任务。

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `'BEGIN_X_SYNC'` | 必填。 |
| `profileId` | `string` | 本地档案编号；缺省时使用默认档案。 |
| `targetLimit` | `number` | 扫描上限，规范化到 1–2000，默认 100。 |
| `downloadMedia` | `boolean` | 是否下载媒体；只有严格为 `false` 时关闭。 |
| `source` | `'x_likes' | 'x_bookmarks'` | 当前页面来源。 |
| `xHandle` | `string` | 当前页面明确显示的已登录用户名，用于绑定校验，不从帖子作者推断。 |

成功响应包含 `success: true`、`runId`、`profileId`、`stats`、`targetLimit`，以及可用于恢复的 `resumePostIds` / `seenPostIds`。`stats` 形状为：

```ts
{ scanned: number; added: number; updated: number; skipped: number; failed: number }
```

### `INGEST_X_BATCH`

保存一个采集批次。`items` 最多接收 50 条，后台会在入库时重新校验档案和当前任务。

```ts
{
  type: 'INGEST_X_BATCH';
  runId: string;
  profileId?: string;
  xHandle?: string;
  items: RawCapturedItem[];
  repairs?: RawCapturedItem[];
}

interface RawCapturedItem {
  postId: string;
  url?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  text: string;
  postedAt?: string | null;
  mediaUrls?: string[];
  mediaAltTexts?: Record<string, string>;
  externalLinks?: string[];
  references?: Array<{ kind: 'quote' | 'reply' | 'article' | 'thread'; id: string; url: string }>;
  isPartial?: boolean;
  missingFields?: string[];
}
```

响应为 `{ success: true, stats }` 或 `{ success: false, error }`。错误响应不会返回 API key、Cookie 或原始请求头。

### `FINISH_X_SYNC`

提交当前任务的终止状态。

```ts
{
  type: 'FINISH_X_SYNC';
  runId: string;
  profileId?: string;
  hasMore: boolean;
  terminalStatus?: 'complete' | 'failed' | 'partial';
  error?: string;
  failureCode?: 'login_required' | 'access_restricted' | 'page_error' |
    'page_not_ready' | 'parse_failed' | 'time_limit' | 'save_interrupted';
  cancelled?: boolean;
  paused?: boolean;
}
```

响应包含 `success`、最终 `status` 和 `stats`。暂停或取消不会删除已经保存的帖子。

### `GET_QUICK_STATS`

请求 `{ type: 'GET_QUICK_STATS', profileId?: string }`，响应为：

```ts
{
  success: true;
  stats: {
    totalPosts: number;
    downloadedMedia: number;
    latestRun?: SyncRun;
  };
}
```

失败时响应 `{ success: false, error: string }`。

## 4. X 页面内容消息

这些消息由 Popup/控制台通过 `chrome.tabs.sendMessage` 发给 X 页的 isolated-world content script。

| 消息 | 请求字段 | 主要响应 |
| --- | --- | --- |
| `PING` | 无；可带 `profileId` | `status`、`url`、`isLikesPage`、`articlesCount`、`failureCode`、`reading`、`profileId`、`xHandle`。 |
| `START_READING` | `limit`、`downloadMedia`、`profileId` | 同步启动后返回 `{ started: true }`；拒绝时返回 `{ started: false, reason }`。 |
| `PAUSE_READING` | `profileId` | `status: 'paused'`、`'idle'` 或 `'ignored'`。 |
| `STOP_READING` | `profileId` | `status: 'stopped'`；不匹配的档案返回 `ignored`。 |
| `STOP_DOM_CAPTURE` | 无 | 终止一次控制台批次采集。 |
| `CAPTURE_STEP` | `limit`、`reset` | `{ success, result }`，其中 `result` 是 `CaptureResult`。 |
| `RELOAD_SINGLE_POST` | `postId` | 页面重新展开并解析可见帖子，成功时返回 `{ success: true, item }`。 |

`CAPTURE_STEP` 的 `result` 形状为 `{ items, hasMore, cursor?, status, error?, failureCode? }`。消息只允许在 X/Twitter 页面匹配的内容脚本中处理；页面切换、账号不匹配或扩展上下文失效时应把错误展示给用户，而不是重试到无界。

## 5. 控制台打开消息

采集结束提示可发送：

```ts
chrome.runtime.sendMessage({
  type: 'OPEN_DASHBOARD',
  profileId: string,
  view?: 'library',
});
```

Service Worker 会复用该档案已经打开的控制台标签页，或创建一个新的 `dashboard.html?profile=<profileId>#library` 标签页。成功响应是 `{ status: 'ok' }`；打开失败是 `{ status: 'error' }`。

## 6. OpenAI-compatible AI 接口

这不是 XlikeMind 的公共服务器 API，而是用户在设置中指定的外部服务。应用会把 `baseUrl` 去掉尾部 `/`，若地址未以 `/chat/completions` 结尾则追加该路径。仅接受 `http` 和 `https`。

### 本地配置形状

```ts
interface AIConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  timeoutSec: number;
  concurrencyLimit: number;
  batchLimit?: number;      // 1–100，默认 20
  allowSendImages: boolean; // 默认 false
  sessionOnlyKey: boolean;
  useMock: boolean;
  updatedAt?: string;
}
```

安全示例见 [`config/ai.example.json`](../config/ai.example.json)。真实密钥不应写入该文件或提交到 Git。

### 请求方式

- 方法：`POST`
- URL：`<baseUrl>/chat/completions`
- 请求头：`Content-Type: application/json`；如果配置了 key，附加 `Authorization: Bearer <apiKey>`。本地 endpoint 在没有 key 时使用本地兼容服务常见的 `Bearer local`。
- `credentials: omit`，重定向策略为 `error`。

连接测试发送最小请求：

```json
{
  "model": "<modelName>",
  "messages": [{"role": "user", "content": "Hello, reply with pong"}],
  "max_tokens": 10
}
```

知识整理请求发送：

```json
{
  "model": "<modelName>",
  "messages": [
    {"role": "system", "content": "结构化知识提取规则"},
    {"role": "user", "content": "原帖作者、URL、正文和外链"}
  ],
  "temperature": 0.2
}
```

开启图片分析并且本地已有合适的图片时，`user.content` 会变成内容数组：先是 `type: "text"`，随后最多两项 `type: "image_url"`，图片以 `data:<mime>;base64,...` 形式发送。图片发送默认关闭。

### 预期响应

应用读取 `choices[0].message.content`，然后从该字符串提取并校验 JSON。对象需要至少包含以下字段：

```json
{
  "titleZh": "中文标题",
  "summaryZh": "1-3 句话摘要",
  "categories": ["综合知识"],
  "tags": [],
  "contentType": "other",
  "steps": [],
  "prerequisites": [],
  "usefulLinks": [],
  "uncertainties": [],
  "risksAndLimits": [],
  "quality": "medium",
  "confidenceNote": "依据原帖正文提取"
}
```

`contentType` 只能是 `tutorial`、`project`、`tool`、`news`、`opinion`、`other`；`quality` 只能是 `high`、`medium`、`low`。如果第一次响应不是合法结构，应用最多向同一接口再发起一次格式修复请求；不会把格式错误当作成功结果。

外链会在本地与原文中的真实链接比对，未在原文中出现的链接不会进入可追溯资源列表。原文、媒体和 AI 结果分开存储，AI 输出不会覆盖原始帖子。

## 7. 安全与兼容性说明

- 本文的 Chrome 消息是内部实现接口，调用方必须处理 `success: false`、连接断开、超时和档案不匹配。
- 不要将 `apiKey`、Cookie、完整帖子导出或私有 endpoint 写入 issue、截图、日志或自动化测试 fixture。
- 只为确实使用的 AI endpoint 授予 Chrome 可选主机权限；不要使用 `<all_urls>` 绕过权限边界。
- 供应商若不支持标准 Chat Completions 字段、拒绝 data URL 图片或返回非 JSON 文本，AI 结果会被标为失败；原文仍可浏览和导出。

## English

This document describes the local data boundary, internal Chrome messages, and the OpenAI-compatible request shape for v0.1.0. XlikeMind has no developer backend and no public HTTP API. The Chrome messages below are implementation details, not a stable third-party SDK.

The extension stores posts, media, sync runs, edits, and AI results in the current local profile’s IndexedDB. Capture reads visible content from the active X page. The original post is never overwritten by an AI result, and missing content is not treated as deletion.

The service worker port is named `xlike-sync`. Supported save messages are `BEGIN_X_SYNC`, `INGEST_X_BATCH`, `FINISH_X_SYNC`, and `GET_QUICK_STATS`; replies carry `success`, optional `stats`, and a redacted `error`. Content-page messages include `PING`, `START_READING`, `PAUSE_READING`, `STOP_READING`, `STOP_DOM_CAPTURE`, `CAPTURE_STEP`, and `RELOAD_SINGLE_POST`. `OPEN_DASHBOARD` opens or reuses a dashboard tab for a local profile.

The AI endpoint is user-configured. The app posts JSON to `<baseUrl>/chat/completions`, omits credentials, uses a Bearer key only when configured, sends text by default, and attaches at most two downloaded images only when image transfer is enabled. It expects a JSON object in `choices[0].message.content` with the fields shown above and retries once only for a response-format error. Never commit real keys or private content. See [`config/ai.example.json`](../config/ai.example.json) and [`PRIVACY.md`](../PRIVACY.md).

