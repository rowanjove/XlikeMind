# XlikeMind 安装与部署

本文面向使用发行包和从源码构建两种方式。XlikeMind v0.1.0 是 Chrome Manifest V3 扩展，不提供桌面 EXE 或开发者后端。

## 1. 环境要求

- 近期稳定版 Google Chrome（支持 Manifest V3、IndexedDB 和 File System Access API）。
- 从源码构建需要 Node.js 22.12+ 与 npm；建议使用仍在维护周期内的 Node.js LTS。
- 使用 X 页面采集时，需要在 Chrome 中登录 X，并能打开点赞或收藏页面。
- 使用 AI 整理时，需要本地 Ollama/LM Studio 服务，或一个兼容 OpenAI Chat Completions 的接口。AI 不是运行扩展的必需条件。

## 2. 安装发行包

1. 下载 `XlikeMind-v<版本>-chrome.zip`，同时下载同一发布中的 `SHA256SUMS.txt`（如发布页提供）。
2. 将 ZIP 解压到长期保留的位置。不要直接从压缩包内选择目录，也不要在每次更新时换用临时目录。
3. 打开 `chrome://extensions`，开启右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择解压目录中的 `extension/` 文件夹；该文件夹的根部应有 `manifest.json`。
5. 将 XlikeMind 固定到工具栏，打开扩展，在「设置」中选择本地文库目录并授予浏览器要求的读写权限。

### 校验发行包

Windows PowerShell：

```powershell
Get-FileHash .\XlikeMind-v<版本>-chrome.zip -Algorithm SHA256
```

macOS/Linux：

```bash
shasum -a 256 XlikeMind-v<版本>-chrome.zip
```

将输出与 `SHA256SUMS.txt` 比较后再解压。发行包还包含 `THIRD_PARTY_NOTICES.txt`、`INSTALL.md` 和 `LICENSE`。

## 3. 从源码构建

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

构建完成后，在 `chrome://extensions` 中选择项目的 `dist/` 目录。`npm run build` 会运行产物结构、引用、权限和必要文件检查。

生成可分发的 Chrome ZIP：

```bash
npm run package:release
```

脚本会先构建和校验 `dist/`，再生成 `release/XlikeMind-v<版本>-chrome.zip`、`SHA256SUMS.txt`、第三方依赖声明和发布说明。发布前请确认 ZIP 中的 `extension/manifest.json` 存在，并在一个独立 Chrome 配置中加载验证。

## 4. 首次使用

1. 打开 X 的点赞页或收藏页，确认列表已经加载，然后刷新页面。
2. 点击工具栏中的 XlikeMind 图标。弹窗会显示当前页面是否可采集、当前档案和本地计数。
3. 选择扫描上限并开始同步；也可以打开完整控制台的「同步」页。采集支持暂停、继续和停止，读取窗口关闭后任务仍会保留在扩展数据库中。
4. 在「文库」页搜索、筛选、编辑帖子，或导出 Markdown/HTML ZIP。
5. 如需固定的离线入口，在「设置」绑定目录；发布后目录中会有当前文库的 `index.html` 和相对媒体文件。

达到扫描上限只表示本批结束，不代表历史点赞或收藏已经全部可见。X 的登录、限流、页面结构和媒体可用性都可能影响采集结果；部分完成或失败状态会保留在同步记录中。

## 5. AI 配置（可选）

AI 配置保存在当前本地档案的 Chrome storage 中。可以参考 [`config/ai.example.json`](../config/ai.example.json) 的字段，但实际配置请在扩展「设置 → 模型与整理」中填写。

- 本地 Ollama/LM Studio 可不填 API key。
- 云端接口需要用户自己的 API key；可开启「关掉浏览器就忘掉」，使 key 只保存在当前会话内。
- 图片发送默认关闭。打开后，每篇最多附带两张已下载图片。
- 点击「测试连接」或首次访问新接口时，Chrome 可能询问接口域名权限；只授予确实使用的接口。
- 不要把真实 API key 写入仓库、Issue、诊断报告或导出文件。

请求字段、返回 JSON 结构和权限边界见 [`docs/API.md`](API.md)；隐私边界见 [`PRIVACY.md`](../PRIVACY.md)。

## 6. 更新、备份与卸载

- 更新前先从「设置 → 导出文库」导出需要保留的内容。
- 发行包更新：先将新包解压到临时目录，再把新包 `extension/` 内的文件更新到原扩展加载目录，在 `chrome://extensions` 点击「重新加载」。保留原加载目录，不通过安装另一个目录来更新。
- 从源码更新：执行 `npm ci` 和 `npm run build`，然后在扩展管理页重新加载 `dist/`。
- 不要先卸载扩展再安装新目录；不同扩展 ID 的 IndexedDB 和 storage 不会自动合并。
- 删除扩展不会替用户删除已导出的本地文件夹，但浏览器中的帖子、媒体、任务和配置可能随扩展数据一起清除。卸载前务必导出备份并确认目录可打开。

## 7. 权限用途

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存本地设置、档案和采集偏好。 |
| `tabs` | 识别 X 页面、查找采集标签页、打开或切换文库页。 |
| `downloads` | 用户主动导出的 ZIP 和诊断文件。 |
| X/Twitter 页面权限 | 读取用户当前打开页面中可见的点赞或收藏内容。 |
| `pbs.twimg.com` | 用户主动采集时下载图片媒体。 |
| 可选 HTTP/HTTPS 接口权限 | 用户配置并授权的 AI endpoint；不用于开发者后台。 |
| 文件夹访问授权 | 将用户主动发布的文库快照写入所选本地目录。 |

## 8. 故障排查

### 扩展图标打开但找不到页面

在 X 点赞或收藏页刷新一次，再打开弹窗。若扩展刚更新，在 `chrome://extensions` 点击「重新加载」后也要刷新 X 标签页。

### 同步提示账号或档案不匹配

检查当前 X 登录账号是否与档案中绑定的用户名一致。绑定信息只用于本地档案边界；不会从帖子的作者推断账号。

### AI 请求失败

检查 endpoint 是否以 `http://` 或 `https://` 开头、路径是否接受 `/chat/completions`、模型名称是否正确，以及 Chrome 是否已授予该 endpoint 的可选权限。不要通过关闭安全策略来绕过失败。

### 文库入口打不开

在「设置 → 保存位置」检查目录授权和 `index.html` 状态；重新授权后再发布一次。已发布的快照使用相对路径，不依赖扩展页面或网络服务。

### 提交问题

请提供 Chrome/Node 版本、复现步骤和脱敏诊断信息。不要上传帖子全文、Cookie、API key、个人账号名或本地绝对路径。

## English

### 可选浏览器验证 / Optional browser verification

`playwright-core` 已列为开发依赖。复制 `.env.example` 为本地 `.env`，将 `LIKEMIND_CHROMIUM` 设置为本机 Chrome 可执行文件路径，然后运行：

```bash
node --env-file=.env scripts/verify-extension.mjs
node --env-file=.env scripts/verify-native-popup.mjs
```

`.env` 不提交到仓库。测试创建独立浏览器配置并拦截请求，仅使用合成样本，不连接个人已登录配置。普通源码构建不需要这些变量。

For optional browser checks, copy `.env.example` to `.env`, set `LIKEMIND_CHROMIUM` to your installed Chrome executable, then run the commands above. Tests use an isolated profile and synthetic responses. These variables are not required for normal builds.

### Requirements

- A recent stable Google Chrome release, with Manifest V3, IndexedDB, and the File System Access API.
- Node.js 22.12+ and npm for source builds; a maintained Node.js LTS release is recommended.
- An X login and an accessible likes or bookmarks page for live capture.
- AI is optional and requires either a local Ollama/LM Studio service or an OpenAI Chat Completions-compatible endpoint.

### Install a release package

1. Download `XlikeMind-v<version>-chrome.zip` and, when available, its matching `SHA256SUMS.txt`.
2. Extract the ZIP into a directory you intend to keep.
3. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
4. Select the extracted `extension/` directory containing `manifest.json`.
5. Open the extension, then choose and authorize a local library directory in Settings.

### Build from source

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run package:release
```

Load `dist/` for development, or use the `extension/` directory inside the generated release ZIP. The release script validates the artifact, creates third-party notices, and writes a SHA-256 checksum.

### First run and updates

Refresh the X likes or bookmarks page, start a bounded sync from the popup or Sync page, then search and export from Library. A scan limit ends the current batch; it does not claim that all history was visible. For updates, copy the new extension files into the original loaded directory and click Reload. Export a backup before updating or uninstalling. Do not uninstall first: a different extension ID does not share IndexedDB or Chrome storage.

### AI and permissions

AI is configured per local profile. Local endpoints may not need a key; cloud endpoints require the user’s own key. Session-only key storage is available, and image transfer is disabled by default. Chrome may request optional access to the configured endpoint. Never commit real keys or upload them in issue reports. See [`docs/API.md`](API.md) and [`PRIVACY.md`](../PRIVACY.md).

