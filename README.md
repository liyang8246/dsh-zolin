# dsh-zolin

自用插件，基于 DeepSeek Harness，三个包可独立安装：

- [Zephyr 编码预设](packages/dsh-zephyr)：`@liyang8246/dsh-zephyr`，精简工具集 + uv_run + 本机 `web_fetch`（可选 Playwright 渲染，需自行 `npx playwright-core install chromium`）
- [模型账号管理](packages/dsh-accounts)：`@liyang8246/dsh-accounts`，支持 Codex、OpenCode Go、CommandCode Go 和 WorkBuddy（国内版/国际版，浏览器扫码登录 + 积分显示）
- [编码统计](packages/dsh-codetime)：`@liyang8246/dsh-codetime`，在设置里填 token，把 Harness 的 AI 编码活动上报到 codetime.dev

## 构建与安装

需要 Node.js ≥22.19、pnpm 11.28.5 和 DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`。

```sh
pnpm install --frozen-lockfile
pnpm build
```

构建后，在 Harness Plugin Manager 中分别安装 `packages/dsh-zephyr`、`packages/dsh-accounts` 或 `packages/dsh-codetime`。
