# Zephyr 编码预设

`dsh-zolin` 的独立 preset bundle，包名 `@liyang8246/dsh-zephyr`，稳定 preset ID 为 `zephyr`。

只保留 Zephyr 原人格与精简工具，不包含账号登录、模型适配器、浏览器 Client 或第三方模型 SDK。账号功能由同仓库的 `@liyang8246/dsh-accounts` 单独提供；**两包没有强制依赖**。

## 能力

- 继承原中文人格与 Ponytail 行为。
- 文件工具、Windows PowerShell / 其他平台 Bash、后台 jobs。
- `uv_run`：`uv run --no-project -`，脚本经 stdin 传入，支持 PEP 723；默认 120 秒，上限 600 秒，超时终止。
- subagent、消息/中断控制、skills、询问、web、present。
- 隔离的上下文压缩与工具结果修剪；隐藏 `load_workspace_dependencies`。

`uv_run` 复用 Host 的工作目录、沙箱策略和取消信号，不另起绕过沙箱的执行器。`uv` 需已在 Host 的 PATH；缓存和 Python 安装目录使用系统临时目录。PEP 723 依赖可能联网，实际可用性取决于本机环境与沙箱。

## 模型与账号

本包不修改 Host 的默认模型、渠道或凭据；沿用已有默认/用户选择。安装账号包后，可在原模型选择器手动选择 `zephyr-*` 渠道，不自动登录、不自动切换模型或账户。

如果会话保存了 `zephyr-*` 模型，而对应账号插件未启用，该路由不可用；不会偷偷改用内置渠道或付费 API。仅安装 preset 仍可使用任何已配置的 Host 模型。

## 开发

工具链、默认 `antfu()` ESLint 配置和锁文件由 monorepo 根统一维护。需 Node.js ≥22.19、pnpm；Harness 运行时范围 `>=0.2.1-rc.5 <0.3.0`。

```sh
pnpm install --frozen-lockfile
pnpm run ci
pnpm --filter @liyang8246/dsh-zephyr build
```

构建仅生成 `lib/uv-run.js`、`lib/restrict.js` 及 bundler 共享 chunk。仓库不包含单元测试，行为需在 Harness 新会话中验证。

## 安装与切换

构建后，经用户授权使用 Harness `plugin_manager` 的 `install_bundle`，目标为本包目录（`packages/dsh-zephyr`），不是 monorepo 根。不要手改真实 profile。

**不要与旧版 `dsh-zephyr` 合并包同时启用**：两者保持同一 `zephyr` preset 标识，会重复注册。迁移时先停用或移除旧 bundle。

安装后的实际激活、工具清单和行为需在新会话验证。
