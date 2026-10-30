# dsh-zephyr-preset

`dsh-zolin` 中可独立安装的 Zephyr bundle，只包含 preset、人格和精简工具；不包含账号插件、渠道、Client 或 SDK。源码位于 `src/`，Host ESM 产物位于 `lib/`。

## 约束

- 修改 patch 前阅读 Harness 随包的 `cordis-composition-reference` skill 或 `cordis-plugin-include` 实现。override 全量替换 `config`；`name` 只是目标断言；表达式只有 `!!js`；`cordis:group` 的子列表放在 `config`。
- preset 子插件模块使用已安装包导出 `dsh-zephyr-preset/restrict`、`dsh-zephyr-preset/uv-run`，不要换成 `./lib/…`：bundle 的相对路径锚定不深入 preset 的 `config.plugins`。
- 稳定标识为 `preset-zephyr` / `zephyr`。人格与原 Zephyr 保持一致；`tests/patch.test.ts` 用解析后 SHA-256 防止误改。
- 不新增模型默认项，不依赖 `dsh-model-accounts`。使用 Host 的模型选择；账号插件单独安装后，其渠道自然可供本 preset 使用。
- 保持原工具集合：文件、平台 shell、jobs、`uv_run`、subagent/control、skills、询问、web、present 和隔离的 compaction。policy 只隐藏 `load_workspace_dependencies`。
- DSH 包仅使用 `import type`；Host 产物不得残留第三方包运行时导入。不要复制另一份 Cordis 或增加 SDK。
- `uv_run` 必须经过 Host `shell`、`workingDirectory`、`sandboxPolicy`，原样传递取消信号，脚本走 stdin，超时上限 600000ms，缓存位于系统临时目录。
- 工具、配置或边界变化需补 Vitest 测试。测试使用 mock，不运行真实 uv、不读取 profile、不触及凭据。缓存使用根配置指定的系统临时目录。
- 使用 monorepo 根的默认 `@antfu/eslint-config`；不要覆盖规则。共享工具链和锁文件位于根目录。修改后运行根 `pnpm run ci`（lint、typecheck、test、build）。
- 不手改 `$DSH_PROFILE_DIR/package.json`、profile patch 或凭据；bundle 仅经用户授权由 `plugin_manager` 安装/移除。不要对 Electron 的 desktop profile 运行 CLI dump。
- 不与仍提供 `zephyr` 的原 `dsh-zephyr` bundle 同时激活：重复 preset 标识会失败。切换安装前必须获得授权；现有会话保留创建时的组合，验证需新会话。

## 文件

- `cordis.patch.yml`：唯一 preset 声明、原人格与工具行。
- `src/uv-run/`：参数校验、工具定义和 Host shell 执行。
- `src/restrict.ts`：隐藏指定继承工具。
- `tests/`：参数、沙箱/cwd/取消/超时、结果格式、隐藏策略和 patch/package 边界。
- `tsdown.config.ts`：仅构建 `uv-run` 与 `restrict`。
- `locale/`、`icon.svg`：bundle 展示资源；不包含账号文案。
