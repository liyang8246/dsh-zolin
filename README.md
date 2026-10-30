# dsh-zolin

DeepSeek Harness 插件 monorepo；两个包可独立安装，不互相依赖。

| 包 | 内容 |
| --- | --- |
| [dsh-zephyr-preset](packages/zephyr/README.md) | Zephyr 人设、精简工具集、`uv_run` |
| [dsh-model-accounts](packages/model-accounts/README.md) | Codex / OpenCode Go / CommandCode Go 登录、多账号、模型路由、额度界面 |

## 开发

Node.js ≥22.19，pnpm 11.28.5。运行时支持 DSH `>=0.2.1-rc.5 <0.3.0`。

```sh
pnpm install --frozen-lockfile
pnpm run ci
pnpm build
```

- 根目录统一 ESLint（`@antfu/eslint-config` 原样默认配置）、TypeScript 和锁文件。
- 业务代码、浏览器界面、构建脚本使用 TypeScript；唯一 JavaScript 源配置是官方推荐的三行 ESLint 入口。
- TypeScript 固定 6.x：当前 ESLint TypeScript 解析器不支持 7.x。
- `pnpm ci` 依次执行 lint、类型检查和两包构建。
- `pnpm models:update` 才联网更新 models.dev 快照；正常构建不访问供应商，不读取真实账号。
- 上游源码（Harness、opencode、pi、codex）固定在 [.agents/clonedeps/lock.json](.agents/clonedeps/lock.json)，只读克隆不入库，说明见 [SOURCES.md](.agents/clonedeps/SOURCES.md)。

## 安装与旧版切换

仓库根目录不是 bundle。构建后，通过 Harness `plugin_manager.install_bundle` 分别选择：

```text
D:\dsh-zolin\packages\zephyr
D:\dsh-zolin\packages\model-accounts
```

也可以仅安装其中一个；账号插件可用于其他智能体，Zephyr 可以使用 Harness 的其他模型渠道。

从旧合并包 `dsh-zephyr` 切换时：

1. 由用户通过 Plugin Manager 移除旧 bundle；不要删除账号、撤销 OAuth 或手改 profile。
2. 安装需要的新包，按 Harness 提示重启，使用新会话验证。
3. 同一 profile 中，新账号包继续读取 `zephyr/accounts`；旧模型路由与会话 replay 标识保留，不需要凭据迁移脚本。

**新旧包不能同时启用**：它们保留相同 preset / provider / tool / RPC 标识；并行运行会发生重复注册及 OAuth 刷新竞争。重建代码不会自动更新当前 GUI。

本仓库从旧合并包 `b1cd09c` 的工作树复制重组；未复制原 Git 历史、`node_modules`、构建产物、真实凭据或未实现的协议调研笔记。原仓库及运行中的安装不受创建此仓库影响。

## 额度同步修复

设置页与聊天输入框订阅同一个内存快照，不再按渠道各自缓存。同渠道换号也立即更新额度；刷新、停用或删除账号时，两处同步更新。晚到的旧列表或 OAuth 额度刷新请求不能覆盖刚完成的操作。Host 保留后台每分钟额度刷新，浏览器同步 Host 快照不会额外请求供应商额度。
