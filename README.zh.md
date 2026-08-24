# dsh-kiro

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Kiro provider，支持 AWS Builder ID 登录、复用 Kiro IDE 凭据、实时发现账号模型、Claude/开放权重模型流式调用、工具调用与 reasoning effort。

插件安装后会自动注册 `kiro` provider 并挂载 bundle，不需要 API key，也不需要手工添加 `cordis.yml` 条目。

## 功能

- 在 **Settings → Kiro** 中完成 AWS Builder ID 设备登录。
- 使用随包提供的 `kiro-login` 命令从终端登录。
- 没有插件自管登录时，自动回退到 Kiro IDE/CLI 的 `~/.aws/sso/cache` 凭据。
- 调用 Kiro `ListAvailableModels`，让模型选择器反映当前账号实际可用的 Opus、Sonnet、Haiku 与开放权重模型。
- 为支持 thinking 的模型提供 `off`、`low`、`medium`、`high` 四档 reasoning effort。
- 解码 Kiro Amazon EventStream 中的文本、推理与工具调用。
- 支持直连或带认证的 HTTP/HTTPS `CONNECT` 代理。
- `llm-kiro` 设置无需重启即可热更新。

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

## 登录

### Web

打开 **Settings → Kiro**，点击 **登录**，然后在浏览器中批准显示的 Builder ID 验证码。页面会轮询设备授权、把凭据保存到 DSH home，并刷新模型目录。

### 终端

通过已安装的 profile 运行：

```sh
dsh plugin --profile web exec kiro-login
```

常用选项：

```sh
kiro-login --region eu-central-1
kiro-login --proxy http://user:pass@proxy.example:8080
kiro-login --no-open
kiro-login --logout
```

CLI 也支持环境变量 `KIRO_REGION` 与 `KIRO_PROXY_URL`。

## 凭据

内置登录只写入 `$DSH_HOME/storages/kiro-auth`（通常为 `~/.dsh/storages/kiro-auth`），token 与设备注册文件权限为 `0600`。**退出**只删除这些由插件管理的文件。

若自管凭据不存在，适配器会读取 Kiro IDE/CLI 的 `~/.aws/sso/cache/kiro-auth-token.json` 及其引用的 client-registration 文件，不会删除或覆盖 Kiro 自己的凭据。过期 access token 通过 AWS OIDC 刷新，并只缓存在内存中。

凭据优先级：

1. dsh-kiro 自管 Builder ID 登录
2. Kiro IDE/CLI SSO 缓存

## 模型发现与推理档位

适配器从 `https://q.<region>.amazonaws.com/ListAvailableModels` 查询当前账号模型，并缓存五分钟。**Settings → Kiro → 发现模型**会强制刷新。模型名、描述、输入上限与输出上限都会映射进 DSH 模型目录。发现接口暂时失败时仍使用配置的后备目录；未列出的模型 id 也会继续透传给 Kiro。

支持 thinking 的模型提供四档 effort：

| 档位 | 行为 |
|---|---|
| `off` | 不添加 thinking 标记。 |
| `low` | 请求较短推理预算。 |
| `medium` | 请求均衡推理预算。 |
| `high` | 请求最大支持推理预算。 |

Kiro 通过提示词标记承载这些档位，而不是原生请求字段。可从 DSH Models 页面设置默认值，或写入：

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
| `thinking` | `enabled` | `disabled` 会把所有模型限制为 `off`。 |
| `reasoningEffort` | `off` | 默认档位：`off`、`low`、`medium` 或 `high`。 |
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

响应为 `vnd.amazon.eventstream` 帧。适配器验证帧边界与 CRC，将 `<thinking>` 内容转为 DSH reasoning block，保留文本、解码工具调用，并过滤已知的开放权重提示词格式残留。

## 为什么部分 Claude 路由需要代理

Kiro 可能同时按账号权益与请求出口授权模型系列。未授权出口下，`claude-*` 可能返回 `INVALID_MODEL`，而开放权重模型仍可工作。需要时可用 `proxyUrl` 提供合适出口。代理使用 HTTP `CONNECT`，TLS 在隧道内协商，因此代理能看到目标主机名，但看不到 bearer token 或请求正文。

## 开发

```sh
npm install
npm run check
npm run pack:dist
```

`npm run check` 会执行类型检查、keyless Vitest 测试、重建提交产物，并检查 Web client 与登录 CLI 语法。

## 已知限制

- Kiro 返回 credits 而非精确 token usage，因此适配器不发出 `usage` chunk。
- 图片输入目前以 `UNSUPPORTED_CONTENT` 拒绝。
- 工具名必须匹配 `^[A-Za-z][A-Za-z0-9_]{0,63}$`。
- 不支持 SOCKS 代理。

## 致谢

Kiro 传输基础在 MIT 许可下源自 [caopu16/dsh-llm-kiro](https://github.com/caopu16/dsh-llm-kiro)。登录与 REST 行为参考并核对了 [dat-lequoc/Kiro-Go](https://github.com/dat-lequoc/Kiro-Go)，DSH Web 集成遵循 [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) 展示的可安装 bundle 模式。原始版权声明保留在 [LICENSE](LICENSE)。

## 许可

MIT
