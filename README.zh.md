# dsh-kiro

<p align="center">
  <img src="assets/kiro-icon.svg" alt="Kiro" width="96" height="96">
</p>

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Kiro provider，支持多种 Kiro 登录、token/profile 自动刷新、实时发现账号模型、Claude/开放权重模型流式调用、工具调用与 reasoning effort。

插件安装后会自动注册 `kiro` provider 并挂载 bundle，不需要 API key，也不需要手工添加 `cordis.yml` 条目。

这是一个独立集成项目，与 AWS 或 Kiro 没有关联，也未获其赞助或认可。Kiro 及其徽标是 Amazon 的商标；详见 [NOTICE.md](NOTICE.md)。

## 安装

```sh
dsh plugin --profile web add github:dat-lequoc/dsh-kiro
dsh --profile web
```

使用 DeepSeek Harness 源码 checkout 时：

```sh
cd ~/deepseek-harness
pnpm dsh plugin --profile web add github:dat-lequoc/dsh-kiro
pnpm dsh --profile web
```

仓库已提交构建后的 `lib/`，所以从 GitHub 安装时不需要执行依赖构建脚本。

## 功能

- 在 **Settings → Kiro** 中使用 AWS Builder ID、IAM Identity Center、Google 或 GitHub 登录。
- 导入 Kiro refresh token、API key 或兼容 CLIProxyAPI 的 Microsoft external-IdP 凭据。
- 导入会报告实际验证到的内容：API key 先与线上模型目录校验，因此页面可以显示`凭据已验证 · 19 个模型可用`；refresh token 因为换取到了真实 access token 而同样报告已验证；external-IdP JSON 只在本地做格式转换，因此显示`凭据已保存`，不会声称做过并不存在的校验。成功后对话框自动关闭，页面上粘贴的密钥被清除，并按当前生效的账号重新读取使用量卡片。
- 使用随包提供的 `kiro-login` 命令从终端完成同类登录。
- 自动发现并保存账号的 CodeWhisperer profile ARN，使刷新后的 token 仍使用正确 profile。
- 没有插件自管登录时，自动回退到 Kiro IDE/CLI 的 `~/.aws/sso/cache` 凭据。
- 调用 Kiro `ListAvailableModels`，让模型选择器反映当前账号实际可用的 Opus、Sonnet、Haiku 与开放权重模型。
- 显示账号套餐、credits 使用量和重置日期，并提供紧凑、可持久化的模型启用列表。
- 自动发现每个模型的 reasoning effort，包括 Kiro 提供的 `none`、`xhigh` 与 `max`。
- 解码 Kiro Amazon EventStream 中的文本、推理与工具调用。
- 向目录声明接受图片的所有模型发送图片，从而启用图片附件与 harness 自带的读图工具。
- 支持直连或带认证的 HTTP/HTTPS `CONNECT` 代理。
- `llm-kiro` 设置无需重启即可热更新。

## 登录

### Web

打开 **Settings → Kiro** 并选择登录方式：Builder ID 使用标准设备授权；IAM Identity Center 还需填写 `https://<company>.awsapps.com/start` 与 region；Google/GitHub 使用 Kiro 的社交设备流程，页面会显示一次性 `XXXX-XXXX` 验证码与 `app.kiro.dev/account/device` 授权网址，插件会等待浏览器授权完成；也可直接导入 refresh token、Kiro API key 或 Microsoft external-IdP JSON。

OAuth 登录完成后，插件会调用 `ListAvailableProfiles`，把选中的 profile ARN 与自管凭据一起保存，并按 ARN 中的 region 发起推理请求。

### 终端

通过已安装的 profile 运行：

```sh
dsh plugin --profile web exec kiro-login
```

常用选项：

```sh
kiro-login --region eu-central-1
kiro-login --method idc --start-url https://company.awsapps.com/start --region eu-central-1
kiro-login --method github
KIRO_REFRESH_TOKEN='…' kiro-login --method refresh-token
KIRO_API_KEY='…' kiro-login --method api-key
kiro-login --method external-idp --credentials-file ./kiro-auth.json
kiro-login --proxy http://user:pass@proxy.example:8080
kiro-login --no-open
kiro-login --logout
```

执行 `kiro-login --help` 可查看全部选项。CLI 支持 `KIRO_REGION`、`KIRO_PROXY_URL`、`KIRO_START_URL`、`KIRO_REFRESH_TOKEN` 与 `KIRO_API_KEY`；敏感值建议放环境变量或受保护的凭据文件，不要直接放命令行参数。

## 凭据

内置登录只写入 `$DSH_HOME/storages/kiro-auth`（通常为 `~/.dsh/storages/kiro-auth`），token 与设备注册文件权限为 `0600`。**退出**只删除这些由插件管理的文件。

自管设备流程凭据（Builder ID、Google、GitHub 与 IDC）通过对应 region 的 AWS OIDC 刷新；单独导入的 refresh token 通过 Kiro desktop auth 服务刷新；Microsoft external-IdP 只允许向受信任的 Microsoft 登录域提交 refresh token。轮换后的自管 refresh token 与发现到的 profile ARN 会原子写回。API key 作为长期凭据使用，并发送 Kiro 要求的 `TokenType: API_KEY`。

若自管凭据不存在，适配器会读取 Kiro IDE/CLI 的 `~/.aws/sso/cache/kiro-auth-token.json` 及其引用的 client-registration 文件，不会删除或覆盖 Kiro 自己的凭据；Kiro 自有凭据刷新后只保存在内存中。

凭据优先级：

1. dsh-kiro 自管凭据
2. Kiro IDE/CLI SSO 缓存

## 模型发现与推理档位

适配器按认证类型选择 Amazon Q 或 CodeWhisperer 接口查询当前账号模型，并缓存五分钟。**Settings → Kiro → 发现模型**会强制刷新。紧凑模型选择器决定哪些路由显示在 DSH 中；选择保存在 `$DSH_HOME/storages/kiro-auth/model-settings.json`，新发现的模型会自动启用。已选模型优先显示，每个系列内按最新版本排序。发现接口暂时失败时仍使用配置的后备目录；未列出的模型 id 也会继续透传给 Kiro，因此取消勾选不会中断已有会话。

账号卡片还会显示 Kiro credits 使用量、套餐和重置日期。使用量缓存五分钟，打开设置页时刷新，也可通过 **刷新使用量** 强制更新。配额接口失败不会影响聊天，也不会清除上次成功结果。

每个模型会从实时 `additionalModelRequestFieldsSchema` 公布自己的 effort 枚举与默认值，具体选项因模型而异；Kiro 当前 schema 包含：

| 档位 | 行为 |
|---|---|
| `none` | 在原生 schema 支持时关闭推理。 |
| `low` | 请求较短推理预算。 |
| `medium` | 请求均衡推理预算。 |
| `high` | 请求较高推理预算。 |
| `xhigh` | 在模型提供时请求扩展高档。 |
| `max` | 在模型提供时请求最高档。 |

DSH 模型菜单只显示当前模型实际提供的选项，并采用 Kiro 给出的模型默认值。适配器通过 Kiro 原生的 `output_config.effort` 或 `reasoning.effort` 字段发送选择；旧的手工后备模型仍兼容 `off`/`low`/`medium`/`high` 提示词标记。可在 DSH 中选择其他档位，或设置可选的部署级覆盖：

```yaml
llm-kiro:
  reasoningEffort: medium
```

## 配置

机器级配置写入 `$DSH_HOME/settings.yaml`（通常为 `~/.dsh/settings.yaml`）：

```yaml
llm-kiro:
  proxyUrl: http://proxy.example:1082
  reasoningEffort: medium
```

所有字段均可选：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `proxyUrl` | 直连 | Kiro 与 OIDC 请求使用的 HTTP/HTTPS 代理，可在 URL 中包含凭据。 |
| `region` | 已登录 token 的 region | 选择 `q.<region>.amazonaws.com`。 |
| `profileArn` | 账号默认值 | 请求与模型发现使用的 CodeWhisperer profile。 |
| `thinking` | `enabled` | `disabled` 会隐藏推理控制并停止发送原生 effort 字段。 |
| `reasoningEffort` | 模型实时默认值 | 可选覆盖：`none`、`off`、`low`、`medium`、`high`、`xhigh` 或 `max`；模型不支持时会拒绝该值。 |
| `defaultContextWindow` | `200000` | 发现接口未返回准确上限时的后备容量。 |
| `models` | 内置后备目录 | 实时发现不可用时使用的建议目录。 |
| `streamIdleTimeoutMs` | `300000` | provider 单次读取允许的最大空闲时间。 |
| `tokenExpiryBufferMs` | `300000` | 提前多久刷新 access token。 |
| `retryPolicy` | 有界常规策略 | 由 `dsh-llm-retry` 执行的 provider 重试策略。 |

若需要把配置固定到单个 profile，可在 `$DSH_HOME/profiles/<名称>/cordis.patch.yml` 按 id 覆盖：

```yaml
- id: llm-kiro
  config:
    proxyUrl: http://proxy.example:1082
```

不要再套一层 `insert:`，bundle 已经插入 `llm-kiro`。

## 请求与响应

Kiro 没有独立 system 槽位，因此 harness system prompt 会放入最早的 user 轮次。历史会标准化为 Kiro 要求的 user/assistant 严格交替；工具 schema 随当前轮次发送；找不到对应调用的工具结果会降为文本，避免压缩后形成无效引用。

### 本插件不做的事

它永不执行压缩。作为适配器，它只负责上游协议这一层：会话应该包含什么由 `dsh-compaction-basic` 决定，依据 token meter 与本插件上报的溢出错误码。因此序列化只修复协议形状——合并同角色连续轮次、填补交替空缺、把孤立工具结果降为文本——但绝不为了让请求「装得下」而丢弃或压缩内容。超出模型窗口的会话会被完整发送，由上游拒绝，而这次拒绝正是 harness 启动恢复的信号。在本地裁剪会丢掉 harness 仍认为存在的轮次，也会掩盖触发压缩的溢出。

唯一的例外是刻意且狭窄的：如果某个文本块的全部内容正是本插件早期自己发出的 `[system: conversation continues]` 填充语，重建历史时会将其丢弃，因为重放它会让模型学着复现该短语。该约束由「plugin boundary: the adapter never compacts」测试固定。

响应为 `vnd.amazon.eventstream` 帧。适配器验证帧边界与 CRC，将原生 `reasoningContentEvent` 帧与旧式 `<thinking>` 内容转为 DSH reasoning block，保留文本、解码工具调用，并过滤已知的开放权重提示词格式残留。

终端 `metadataEvent` 提供结束原因：`END_TURN`、`TOOL_USE`、`MAX_TOKENS`、`MODEL_CONTEXT_WINDOW_EXCEEDED`、`CONTENT_FILTERED`、`PAUSE_TURN` 分别映射到对应的 DSH 结果；无法识别的原因会以可诊断的错误码结束该轮，而不是伪装成成功。

### 生成参数

`generateAssistantResponse` 只声明了 `conversationState`、`profileArn`、agent-mode 请求头、`additionalModelRequestFields` 与 `systemPrompt`，并没有 `inferenceConfig`：顶层生成参数对象会被服务接受但直接忽略，因此本适配器不再发送它。

`additionalModelRequestFields` 会按每个模型通过 `ListAvailableModels` 公布的 schema 校验，而该 schema 是 `additionalProperties: false`。因此适配器只发送当前模型明确公布的字段：

- 推理档位写入模型声明的 `output_config.effort` 或 `reasoning.effort`。
- 请求中的 `maxTokens` 写入 `max_tokens`，并夹到模型公布的 `minimum`/`maximum` 之间（较新的 Claude 路由目前是 1024–128000）。
- 完全不公布 schema 的模型不会收到 `additionalModelRequestFields`，因为该成员本身会被拒绝。

其余参数没有可用位置。`temperature`、`topP` 与 stop 序列不属于该操作的契约（发送未公布的属性会直接被拒绝），因此这些选项会被忽略而不是发送。

### 图片

只要模型的目录条目声明了 `supportedInputTypes: ["TEXT","IMAGE"]`，即可发送图片——在实测账号上为 19 个模型中的 17 个，包含全部 Claude 路由；`glm-5` 与 `minimax-m2.5` 只报告文本。该能力从目录读取而非按模型 id 猜测，因此路由获得或失去该能力都无需改代码；`models[].inputModalities` 可在某个套餐不一致时覆盖，而完全没有声明的模型保持纯文本——未声明的能力不应被假定。

Kiro 接受 png、jpeg、gif 与 webp。图片会在 base64 展开前重新编码到最多 8000x8000 像素、3.75 MB，与其模型所在服务的上限一致，并以 `userInputMessage.images` 发送，即 `ImageBlock { format, source: { bytes } }`。

在该协议中只有 user 轮次有图片位置。服务的 `AssistantResponseMessage` 没有该字段，因此历史中 assistant 侧的图片会被拒绝而不是被丢弃；`ToolResultContentBlock` 只是 text 与 json 的联合，因此工具返回的图片会被提升到携带该工具结果的 user 轮次上——这是能保留它的最近位置。图片字节存放在 harness 的 attachment 服务中，因此未挂载该服务、或版本早于其 request-image 编码器的 profile，会直接报告不支持图片，而不是在请求中途失败。

### Token 统计

存在两种信号，适配器优先使用精确的那一种。

当 `metadataEvent` 携带 `tokenUsage` 时，其计数直接映射为 DSH 原生 token usage：未缓存输入、输出、缓存读取与缓存写入，不估算、不重复计数。`totalTokens` 仅用于在某些路由只上报总数而缺少未缓存输入时反推该项。

Kiro 并非在所有路由上都发送 `tokenUsage`——本账号的所有实测请求都没有收到。但它在每次请求都会发送 `contextUsageEvent`，而 wire schema 也把 `contextUsagePercentage` 视为 token 统计的一部分；因此在没有精确计数时，适配器会用该百分比乘以模型公布的上下文窗口来定价。这不只影响展示：DSH 的 token meter 需要以上游用量为锚点，缺失时只能整段用本地启发式估算，压缩阈值会随之漂移。两个参考实现都以相同方式、出于相同原因转换该百分比。

需要明确的是：输入侧是上游自己给出的「窗口占用」测量值，精度取决于上游上报的精度，并非单次请求的精确计数；输出侧完全没有上游信号，由本次流式输出的字符数换算。缓存分项绝不会凭空生成，只有 Kiro 上报时才会出现。

缓存分项只在 Kiro 上报时才出现，而实测中没有任何路由会上报——因此 DSH 显示 `Cache hit 0%`，其含义是「未上报」而不是「没有命中缓存」。缓存确实在发生：同一长前缀的重复请求消耗 0.0417 credits，而首次为 0.0787，降低 47%。Kiro 在服务端按前缀做缓存，因此多轮循环中重发历史本身就能受益；它只是不发送 `cacheReadInputTokens`，而适配器不会凭空造出该值。

服务模型在 `UserInputMessage`、`AssistantResponseMessage` 以及 `Tool` 联合类型中都声明了 `cachePoint: {type: 'default'}`；实测发送会被接受，但没有任何影响：带与不带的冷/热请求 credits 消耗在 17 位有效数字上完全一致。该实验保留在 `tests/live-cache.spec.ts`，以便随时复测而非靠推断。

设置页中的账号 credits 使用量属于套餐层面的独立数据，绝不会换算为单次请求的 token 数。

## 为什么部分 Claude 路由需要代理

Kiro 可能同时按账号权益与请求出口授权模型系列。未授权出口下，`claude-*` 可能返回 `INVALID_MODEL`，而开放权重模型仍可工作。需要时可用 `proxyUrl` 提供合适出口。代理使用 HTTP `CONNECT`，TLS 在隧道内协商，因此代理能看到目标主机名，但看不到 bearer token 或请求正文。

## 错误

适配器会把上游失败映射为稳定的 DSH 错误码：`AUTH`、`FORBIDDEN`、`RATE_LIMIT`、`INVALID_MODEL`、`INVALID_REQUEST`、`SERVER`、`TRANSPORT`、`ABORTED`、`TIMEOUT`、`STREAM_CLOSED`、`MALFORMED_RESPONSE`、`EMPTY_RESPONSE`。

套餐额度用尽会映射为 `QUOTA`：Kiro 可能以 HTTP 402 上报，有时也用 403 或原因为月度/每日额度的限流（`MONTHLY_REQUEST_COUNT`、`CREDIT_CONSUMPTION_RATE_EXCEEDED`）。重试无法解决，因此不能显示为速率限制或权限问题。

当 Kiro 因内容超限拒绝请求时，会映射为 `CONTEXT_WINDOW_EXCEEDED`——依据其 `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 校验原因以及官方客户端同样识别的 `Input is too long.` / `Prompt is too long.` 文案。只有这个错误码会触发 DSH 的紧急压缩并重试该轮；其他 HTTP 400 仍是 `INVALID_REQUEST`，因为压缩无法修复格式错误的请求。

## 开发

```sh
npm install
npm run check
npm run pack:dist
```

`npm run check` 会执行类型检查、keyless Vitest 测试、重建提交产物，并检查 Web client 与登录 CLI 语法。

`tests/live-*.spec.ts` 中的三个探针会访问已登录的 Kiro 账号，未设置 `KIRO_LIVE=1` 时自动跳过。它们分别记录真实请求返回的流帧、验证超长请求的分类结果，并跑通两轮工具调用循环，用于对照真实账号（而非固定 fixture）核验协议契约：

```sh
KIRO_LIVE=1 KIRO_MODEL=claude-opus-5 KIRO_EFFORT=high npx vitest run tests/live-frames.spec.ts
```

`tests/session-replay.spec.ts`（`DSH_SESSIONS=1`）会把本地 DSH 会话存档重放给序列化器；`verification/` 目录提供一个不消耗额度的验证装置，用于证明本适配器上报的上下文溢出会触发 DSH 压缩并重试该轮。

## 已知限制

- 图片输入目前以 `UNSUPPORTED_CONTENT` 拒绝。
- `temperature`、`topP` 与 stop 序列在 Kiro 的 `generateAssistantResponse` 请求中没有可用位置，会被忽略。
- 工具名必须匹配 `^[A-Za-z][A-Za-z0-9_]{0,63}$`。
- 不支持 SOCKS 代理。

## 致谢

Kiro 传输基础在 MIT 许可下源自 [caopu16/dsh-llm-kiro](https://github.com/caopu16/dsh-llm-kiro)。登录、profile ARN、API key 与 external-IdP 行为参考并核对了 [decolua/9router](https://github.com/decolua/9router) 和 [dat-lequoc/Kiro-Go](https://github.com/dat-lequoc/Kiro-Go)。DSH Web 集成遵循 [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) 展示的可安装 bundle 模式。原始版权声明保留在 [LICENSE](LICENSE)。

## 许可

MIT
