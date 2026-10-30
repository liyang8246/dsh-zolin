# dsh-zolin

自用插件，基于 DeepSeek Harness，两个包可独立安装：

- [Zephyr 编码预设](packages/dsh-zephyr)：`@liyang8246/dsh-zephyr`
- [模型账号管理](packages/dsh-accounts)：`@liyang8246/dsh-accounts`，支持 Codex、OpenCode Go 和 CommandCode Go

## 构建与安装

需要 Node.js ≥22.19、pnpm 11.28.5 和 DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`。

```sh
pnpm install --frozen-lockfile
pnpm build
```

构建后，在 Harness Plugin Manager 中分别安装 `packages/dsh-zephyr` 或 `packages/dsh-accounts`。
