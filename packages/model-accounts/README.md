# Model Accounts

独立的 Harness Host + Client 插件；不声明人设、预设或默认模型，不依赖 Zephyr 包。

## 使用

在仓库根目录安装依赖、构建，再通过 Plugin Manager 安装本包目录。打开 **设置 → 模型账号**：

- **OpenAI Codex**：浏览器 OAuth，本机回调 `127.0.0.1:1455`；无法回调时粘贴完整跳转地址。
- **OpenCode Go**：浏览器设备授权，按授权组织绑定；旧授权缺组织时按名称排序选择首个组织。
- **CommandCode Go**：输入 `user_…` API Key。

每个渠道可保存多个账号，最多一个启用。首个账号自动启用，后续添加不抢选择；停用或删除后不自动换号。请求准备时固定账号，切换不影响进行中的请求。

| 渠道 | 保留的模型路由 | 传输 |
| --- | --- | --- |
| Codex | `zephyr-openai-codex` | Codex Responses |
| OpenCode Go | `zephyr-opencode-go` | OpenAI 兼容流，带会话与组织信息 |
| CommandCode Go | `zephyr-commandcode-go` | CLI `/alpha/generate` NDJSON |

全局工具 `zephyr_accounts` 支持列举、切换、重命名、删除和刷新额度；登录与输入凭据仅限用户界面。

## 额度

Host 每分钟顺序刷新已保存账号，两账号间隔五秒；手动刷新最多三个并发。设置页与聊天输入框共用一个快照 store，同渠道换号也会立即通知所有订阅者；旧请求不能覆盖后续切号或删除结果。浏览器只同步 Host 已有快照，不额外轮询供应商；错误或缺失额度不会伪装为零用量。

- OpenAI：`/backend-api/wham/usage`。
- OpenCode Go：`/zen/go/v1/usage`；403 表示该组织无 Go 额度，其他 HTTP 错误保留。
- CommandCode Go：`/alpha/whoami?limits=1`，必要时查询组织 credits/subscriptions；只有明确总额才计算月百分比。

进度条显示**剩余额度**，不是已用比例。缺失窗口不绘制，不从本地 token 计数推算订阅额度。

## 凭据与兼容

- 沿用同一 profile 的 Harness `zephyr/accounts` grant，版本仍为 1。包改名不改存储键，不需要导出/迁移凭据。
- 凭据不进入配置、浏览器持久存储、模型工具输出或日志。沿用宿主凭据后端，不额外承诺操作系统密钥链加密。
- OAuth 刷新在 Harness 独占锁内再次确认；令牌开始轮换后，先保存新 refresh token，再响应调用方取消。
- 保留旧 provider、`zephyr_accounts`、`/api/zephyr-models` 和 `zephyr-pi` replay 标识；不可与旧合并包同时启用。
- 删除只移除本地保存登录；撤销上游授权需要在供应商平台完成。
- OpenAI/OpenCode 传输和 OpenAI OAuth 继续复用内联打包的 pi-ai；重写的是存储、登录状态机、Host 编排和类型化界面，不复制其协议实现。
- Codex 模型来自当前账号实时权限目录，仅保留 `visibility=list` 且 `supported_in_api=true`，缓存十分钟；不回退到硬编码或付费 API。OpenCode/CommandCode 使用已提交的 models.dev 离线快照。
- CommandCode 网关不是稳定公共 API，服务端升级可能破坏兼容；当前仅声明文字输入。OpenAI/OpenCode 支持目录标注的图片，文件只使用 Harness 文本投影。

## 开发

在 monorepo 根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run ci
pnpm --filter dsh-model-accounts build
pnpm models:update
```

关键文件：

- [accounts.ts](src/accounts.ts)：唯一凭据记录、验证、原子变更与刷新锁。
- [logins.ts](src/logins.ts)：用户登录状态机、超时与取消。
- [service.ts](src/service.ts)：账号操作、模型目录与额度刷新。
- [index.ts](src/index.ts)：Host 工具、受宿主鉴权的 RPC 与模型路由生命周期。
- [client.tsx](src/client.tsx)：类型化 React 界面；[store.ts](src/client/store.ts) 统一前端快照。
- [update-models.ts](scripts/update-models.ts)：显式更新与离线完整性校验。

第三方协议参考固定在 [clonedeps lock](.agents/clonedeps/lock.json)。源码可按 lock 同步到只读克隆目录；不在克隆中运行代码。
