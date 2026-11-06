# dsh-zolin

DeepSeek Harness 插件集。按需安装：

- [Zephyr](packages/dsh-zephyr)：精简编码工具集，提供 `uv_run` 与本机 Chromium `web_fetch`
- [Accounts](packages/dsh-accounts)：登录 Codex、OpenCode Go、CommandCode Go、WorkBuddy
- [CodeTime](packages/dsh-codetime)：配置 token，将 Harness 编码活动上报至 codetime.dev

## 构建

Node.js ≥22.19，pnpm 11.28.5，Harness `>=0.2.1-rc.5 <0.3.0`

```sh
pnpm install --frozen-lockfile
pnpm build
```

在 Plugin Manager 安装对应 `packages/` 子目录
