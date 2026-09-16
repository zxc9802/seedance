# OpenLux 用量上报

仅实际请求 hostname 为 `api.openlux.ai` 的模型调用会上报到主站；现有云雾、Shanbao、火山、Kie、fal 等默认地址和业务路由保持原配置。不会根据模型名称或环境变量名称猜测供应商。

## 配置和部署顺序

先部署支持 `pending` 状态的主站 `POST /api/sso/usage`，再部署本工具。主站 `SSO_USAGE_SECRETS` 增加本工具的独立密钥，不能复用 API Key。

```text
MAIN_APP_URL=https://your-main-app.example
USAGE_MONITOR_INTERNAL_SECRET=<本工具独立的服务端密钥，至少32字符>
USAGE_MONITOR_OUTBOX_DIR=/var/lib/seedance/usage-monitor
```

工具标识为 `seedance`。缺少主站地址或上报密钥时不启用上报；不修改原有生成、预留、结算或积分逻辑。密钥仅在发送时从环境读取，不写入磁盘。

`USAGE_MONITOR_OUTBOX_DIR` 必须挂载到持久可写目录；默认是工作目录下 `data/usage-monitor`。队列在 `outbox/`，异步任务和原始请求的对应关系在 `tasks/`。只保存主站用户 ID、请求 UUID、实际供应商/模型、状态和真实 Token；不保存提示词、回复、图片、URL、文件或 API Key。任务元数据保留用于去重，备份时应与队列一起保存。

## 计量和重试

- 只从已验证的 SSO 会话取主站 `user.id`，不使用正文中的用户字段，也不把本地开发占位用户上报到主站。
- 每次实际模型 HTTP 请求（包括上游重试）使用独立 UUID。重复发送同一记录保留 UUID；主站按 UUID 幂等处理。
- 输入包含缓存分项；Gemini 推理 Token 计入输出。输入和输出齐全时总数为两者之和，避免重复累计。图片输入分项来自上游；缺失 Token 为 `null`，不以内容长度估算，不在工具端计算金额。
- 异步视频/图片创建返回任务 ID 后保持 `pending`；确认上游终态后用原请求 UUID 更新。查询和下载不增加模型调用次数。查询接口临时失败不代表生成任务失败。
- 单次投递超时 2 秒，每次重试批次最多 10 条；只有主站 HTTP 成功且 JSON `success === true` 才移除队列。网络失败、未确认成功和主站拒绝均保留。
- 模型请求会触发积压队列重试。可在相同部署目录和环境下运行：

```sh
npm run usage:retry
```

一次命令仅处理一个有限批次；队列较多时重复运行或由部署环境定时执行。需要从环境文件加载配置的本地命令可用 `node --env-file=.env.local scripts/usage-retry.mjs`。文件系统不可写时会输出无敏感内容的警告，不阻断已获成功的生成；此类事件无法保证持久投递，应修复持久目录权限。

现有后台聚合任务状态同步循环同时重试上报。上游任务只有在现有轮询/后台查询获得终态时才能完成；未再查询或进程在提交后、保存上游任务编号前中止的记录保持待核对。继承现有 /api/video-sso/billing 外部用户积分结算，不更改该协议。API Key relay 没有已验证的 SSO 用户，不伪造主站员工归属。

## 验证

测试均使用模拟模型响应、临时目录和虚构员工，不调用付费模型、不读取生产数据。覆盖 provider 排除、null/zero/cache/image 分项、真实重试与投递重试、磁盘恢复、并发用户隔离和异步任务去重。
