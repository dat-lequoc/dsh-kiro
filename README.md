# dsh-kiro

English | [中文](README.zh.md)

Kiro provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with AWS Builder ID login, automatic reuse of Kiro IDE credentials, live account model discovery, Claude/open-weight streaming, tool calls, and reasoning effort controls.

The bundle registers the `kiro` provider route and mounts itself when installed. No API key or manual `cordis.yml` entry is required.

## Features

- Sign in from **Settings → Kiro** with the AWS Builder ID device flow.
- Sign in from a terminal with the included `kiro-login` command.
- Fall back to Kiro IDE/CLI's existing `~/.aws/sso/cache` sign-in when no plugin-managed login exists.
- Query Kiro's `ListAvailableModels` endpoint so the model picker reflects the signed-in account (Opus, Sonnet, Haiku, and available open-weight routes).
- Expose `off`, `low`, `medium`, and `high` reasoning efforts on thinking-capable models.
- Stream text, reasoning, and tool calls from Kiro's Amazon EventStream protocol.
- Support direct egress or an authenticated HTTP/HTTPS `CONNECT` proxy.
- Hot-reload `llm-kiro` settings without restarting DSH.

## Install

```sh
dsh plugin --profile web add github:dat-lequoc/dsh-kiro
dsh --profile web
```

From a DeepSeek Harness source checkout, use its launcher:

```sh
cd ~/deepseek-harness
pnpm dsh plugin --profile web add github:dat-lequoc/dsh-kiro
pnpm dsh --profile web
```

Built `lib/` artifacts are committed, so a GitHub install does not need to execute a dependency build script.

## Sign in

### Web

Open **Settings → Kiro**, select **Sign in**, and approve the displayed Builder ID code in the browser. The page polls the device flow, stores the completed credential below DSH home, and refreshes the model catalog.

### Terminal

Run the installed binary through the profile:

```sh
dsh plugin --profile web exec kiro-login
```

Useful options:

```sh
kiro-login --region eu-central-1
kiro-login --proxy http://user:pass@proxy.example:8080
kiro-login --no-open
kiro-login --logout
```

`KIRO_REGION` and `KIRO_PROXY_URL` are equivalent environment variables for the CLI.

## Credentials

The bundled login writes only to `$DSH_HOME/storages/kiro-auth` (normally `~/.dsh/storages/kiro-auth`). Token and device-registration files are mode `0600`. **Sign out** deletes only these plugin-owned files.

When managed credentials are absent, the adapter reads Kiro IDE/CLI's `~/.aws/sso/cache/kiro-auth-token.json` and its referenced client-registration file. It never deletes or overwrites Kiro-owned credentials. Expired access tokens are refreshed in memory through AWS OIDC.

Credential priority is:

1. dsh-kiro managed Builder ID login
2. Kiro IDE/CLI SSO cache

## Model discovery and reasoning

The adapter asks `https://q.<region>.amazonaws.com/ListAvailableModels` for the signed-in account and caches the result for five minutes. **Settings → Kiro → Discover models** forces a refresh. Model names, descriptions, input limits, and output limits are projected into the DSH catalog. If discovery is temporarily unavailable, the configured fallback catalog remains usable; unlisted model IDs are still passed through to Kiro.

Thinking-capable routes advertise four effort IDs:

| Effort | Behavior |
|---|---|
| `off` | No thinking marker is added. |
| `low` | Requests a short reasoning budget. |
| `medium` | Requests a balanced reasoning budget. |
| `high` | Requests the largest supported reasoning budget. |

Kiro carries these controls through prompt markers rather than a native request field. Set the default from the DSH Models page or in `settings.yaml`:

```yaml
llm-kiro:
  reasoningEffort: medium
```

## Configuration

Put machine-level configuration in `$DSH_HOME/settings.yaml` (normally `~/.dsh/settings.yaml`):

```yaml
llm-kiro:
  proxyUrl: http://proxy.example:1082
  reasoningEffort: medium
```

Every field is optional:

| Field | Default | Meaning |
|---|---|---|
| `proxyUrl` | direct | HTTP/HTTPS proxy for Kiro and OIDC requests; credentials in the URL are supported. |
| `region` | signed-in token region | Selects the `q.<region>.amazonaws.com` endpoint. |
| `profileArn` | account default | CodeWhisperer profile used for requests and model discovery. |
| `thinking` | `enabled` | `disabled` restricts all models to effort `off`. |
| `reasoningEffort` | `off` | Default: `off`, `low`, `medium`, or `high`. |
| `defaultContextWindow` | `200000` | Fallback capacity when discovery reports no exact limit. |
| `models` | bundled fallback | Advisory fallback catalog; live account discovery normally replaces it. |
| `streamIdleTimeoutMs` | `300000` | Maximum idle time while a provider read is outstanding. |
| `tokenExpiryBufferMs` | `300000` | Refresh an access token this long before expiration. |
| `retryPolicy` | bounded normal | Provider retry policy executed by `dsh-llm-retry`. |

To pin values to one profile instead, patch the bundle row by id in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: llm-kiro
  config:
    proxyUrl: http://proxy.example:1082
```

Do not wrap this override in `insert:`; the bundle already inserts `llm-kiro`.

## Request and response behavior

Kiro has no separate system slot, so the harness system prompt is placed on the earliest user turn. Conversation history is normalized to Kiro's strict user/assistant alternation, tool schemas are attached to the current turn, and orphaned tool results are carried as text so compaction cannot leave an invalid tool-call reference.

Responses arrive as `vnd.amazon.eventstream` frames. The adapter validates frame boundaries and CRCs, routes `<thinking>` runs into DSH reasoning blocks, preserves text blocks, decodes tool calls, and suppresses known open-weight prompt-format artifacts.

## Why some Claude routes need a proxy

Kiro can authorize model families by request egress as well as account entitlement. From an unauthorized egress a `claude-*` model may fail with `INVALID_MODEL` while open-weight routes work. `proxyUrl` provides the required egress when applicable. The adapter uses an HTTP `CONNECT` tunnel with TLS negotiated inside it, so the proxy sees the target hostname but not the bearer token or request body.

## Errors

The adapter maps provider failures to stable DSH codes: `AUTH`, `FORBIDDEN`, `RATE_LIMIT`, `INVALID_MODEL`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `ABORTED`, `TIMEOUT`, `STREAM_CLOSED`, `MALFORMED_RESPONSE`, and `EMPTY_RESPONSE`.

## Development

```sh
npm install
npm run check
npm run pack:dist
```

`npm run check` type-checks, runs the keyless Vitest suite, rebuilds committed artifacts, and syntax-checks the web client and login CLI.

## Known limitations

- Kiro reports consumed credits rather than exact token usage, so the adapter emits no `usage` chunk.
- Image content is currently rejected with `UNSUPPORTED_CONTENT`.
- Tool names must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`.
- SOCKS proxies are not supported.

## Acknowledgements

The Kiro transport foundation is derived under MIT from [caopu16/dsh-llm-kiro](https://github.com/caopu16/dsh-llm-kiro). Login and REST behavior were cross-checked against [dat-lequoc/Kiro-Go](https://github.com/dat-lequoc/Kiro-Go), and the DSH Web integration follows the installable-bundle pattern demonstrated by [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity). Original copyright notices are retained in [LICENSE](LICENSE).

## License

MIT
