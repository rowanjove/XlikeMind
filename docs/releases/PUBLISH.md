# 发布 v0.1.0 到 GitHub

## 当前准备范围

源码版本、manifest版本均为0.1.0，许可证Apache-2.0，发布范围仅Chrome扩展。

## 本地检查与打包

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run package:release
```

发行文件位于忽略提交的 `release/`：

- `XlikeMind-v0.1.0-chrome.zip`：解压后加载 `extension/`。
- `SHA256SUMS.txt`：发行ZIP校验值。
- `THIRD_PARTY_NOTICES.txt`：第三方组件许可。

ZIP内还包含Apache-2.0 LICENSE及INSTALL.md。打包脚本会重新打开ZIP检查CRC、逐文件字节，再解压到独立临时目录检查实际入口依赖。已配置Playwright环境时可附加 `-- --smoke` 验证解压后的原生弹窗。

## 创建仓库后

1. 在GitHub新建仓库，建议名称 `XlikeMind`，不要额外初始化README或许可证，以免与当前文件冲突。
2. 将本地源码提交并推送到该仓库。`dist/`、`release/`、node_modules和本地密钥文件已忽略；不要将个人文库目录放入仓库。
3. 检查Actions的类型、lint、测试、打包结果。工作流只上传Actions构建附件，不自动创建公开Release。
4. 创建标签 `v0.1.0`，以 `docs/releases/v0.1.0.md` 为Release正文，上传上述三个发行文件。

首次上传前可用 `git status --short` 查看实际提交范围，推送后查看GitHub Actions执行结果。

## 数据保留

既有开发版使用原目录更新并重新加载，保留旧扩展，升级前导出备份。本次不更换manifest key，不自动迁移或清理个人数据。Chrome关于扩展标识的说明见 https://developer.chrome.com/docs/extensions/reference/manifest/key 。
