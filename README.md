# dsh-kiro

<p align="center">
  <img src="assets/kiro-icon.svg" alt="Kiro" width="96" height="96">
</p>

English | [中文](README.zh.md)

Kiro provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with multi-method Kiro login, automatic token/profile refresh, live account model discovery, Claude/open-weight streaming, tool calls, and reasoning effort controls.

The bundle registers the `kiro` provider route and mounts itself when installed. No API key or manual `cordis.yml` entry is required.

This is an independent integration and is not affiliated with or endorsed by AWS or Kiro. Kiro and its logo are Amazon trademarks; see [NOTICE.md](NOTICE.md).

## Features

- Sign in from **Settings → Kiro** with AWS Builder ID, IAM Identity Center, Google, or GitHub.
- Import a Kiro refresh token, API key, or CLIProxyAPI-compatible Microsoft external-IdP credential.
- Sign in with the same methods from a terminal using the included `kiro-login` command.
- Discover and persist the account's CodeWhisperer profile ARN so refreshed tokens keep the correct profile.
- Fall back to Kiro IDE/CLI's existing `~/.aws/sso/cache` sign-in when no plugin-managed login exists.
- Query Kiro's `ListAvailableModels` endpoint so the model picker reflects the signed-in account (Opus, Sonnet, Haiku, and available open-weight routes).
- Show the account plan, credit usage, and reset date, with a compact persistent model allowlist.
- Auto-discover each model's reasoning efforts, including `none`, `xhigh`, and `max` where Kiro offers them.
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

Open **Settings → Kiro** and select a method:

- **AWS Builder ID** uses the standard device-code flow.
- **IAM Identity Center** uses a device flow with your `https://<company>.awsapps.com/start` URL and region.
- **Google / GitHub** uses Kiro's social device flow. The page shows a one-time `XXXX-XXXX` code and an `app.kiro.dev/account/device` authorization URL while the plugin waits for completion.
- **Refresh token**, **Kiro API key**, and **Microsoft external IdP JSON** validate/import an existing credential without exposing it back to the browser status API.

After an OAuth login, the plugin queries `ListAvailableProfiles`, saves the selected profile ARN with its managed credential, and uses the ARN's region for inference.

### Terminal

Run the installed binary through the profile:

```sh
dsh plugin --profile web exec kiro-login
```

Useful options:

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

Run `kiro-login --help` for all options. `KIRO_REGION`, `KIRO_PROXY_URL`, `KIRO_START_URL`, `KIRO_REFRESH_TOKEN`, and `KIRO_API_KEY` are supported environment variables. Environment variables or a protected credential file are preferable to secret command-line arguments.

## Credentials

The bundled login writes only to `$DSH_HOME/storages/kiro-auth` (normally `~/.dsh/storages/kiro-auth`). Token and device-registration files are mode `0600`. **Sign out** deletes only these plugin-owned files.

Managed device-flow credentials (Builder ID, Google, GitHub, and IDC) refresh through regional AWS OIDC; standalone imported refresh tokens use Kiro's desktop auth service; Microsoft external-IdP credentials refresh only against approved Microsoft login hosts. Rotated managed refresh tokens and discovered profile ARNs are written atomically. API keys are treated as long-lived and carry Kiro's required `TokenType: API_KEY` header.

When managed credentials are absent, the adapter reads Kiro IDE/CLI's `~/.aws/sso/cache/kiro-auth-token.json` and its referenced client-registration file. It never deletes or overwrites Kiro-owned credentials; refreshed Kiro-owned tokens remain in memory only.

Credential priority is:

1. dsh-kiro managed credential
2. Kiro IDE/CLI SSO cache

## Model discovery and reasoning

The adapter asks the auth-appropriate Amazon Q/CodeWhisperer surface for the signed-in account and caches the result for five minutes. **Settings → Kiro → Discover models** forces a refresh. The compact model selector controls which routes appear in DSH; choices persist in `$DSH_HOME/storages/kiro-auth/model-settings.json`, and newly discovered models are enabled automatically. Selected models appear first, with the latest version first inside each family. If discovery is temporarily unavailable, the configured fallback catalog remains usable; unlisted model IDs are still passed through to Kiro so an existing session is not broken by a checkbox change.

The account card also reads Kiro's credit usage, plan, and reset date. Usage is cached for five minutes, refreshed when the settings page opens, and can be forced with **Refresh usage**. A quota failure does not disable chat or discard the last successful reading.

Each route advertises the effort enum and default from its live
`additionalModelRequestFieldsSchema`. The exact choices vary by model; current
Kiro schemas include:

| Effort | Behavior |
|---|---|
| `none` | Disables reasoning on models whose native schema offers it. |
| `low` | Requests a short reasoning budget. |
| `medium` | Requests a balanced reasoning budget. |
| `high` | Requests a large reasoning budget. |
| `xhigh` | Requests extended high effort when advertised. |
| `max` | Requests the model's maximum effort when advertised. |

DSH's model menu exposes only the choices for the selected model and follows that model's Kiro-provided default. The adapter sends the selection through Kiro's native `output_config.effort` or `reasoning.effort` request field. Models from an older manually configured fallback catalog retain the legacy `off`/`low`/`medium`/`high` prompt-marker behavior. Choose another level in DSH or set an optional deployment-wide override in `settings.yaml`:

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
| `thinking` | `enabled` | `disabled` suppresses reasoning controls and native effort fields. |
| `reasoningEffort` | model's live default | Optional override: `none`, `off`, `low`, `medium`, `high`, `xhigh`, or `max`; unsupported values are rejected for that model. |
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

Kiro's terminal response metadata is mapped to DSH's native token usage buckets: uncached input, output, cache reads, and cache writes. This powers session input/output totals, decode throughput, and cache-hit metrics without estimates or double-counting.

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

- Image content is currently rejected with `UNSUPPORTED_CONTENT`.
- Tool names must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`.
- SOCKS proxies are not supported.

## Acknowledgements

The Kiro transport foundation is derived under MIT from [caopu16/dsh-llm-kiro](https://github.com/caopu16/dsh-llm-kiro). Login, profile-ARN, API-key, and external-IdP behavior was cross-checked against [decolua/9router](https://github.com/decolua/9router) and [dat-lequoc/Kiro-Go](https://github.com/dat-lequoc/Kiro-Go). The DSH Web integration follows the installable-bundle pattern demonstrated by [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity). Original copyright notices are retained in [LICENSE](LICENSE).

## License

MIT
