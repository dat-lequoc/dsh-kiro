# dsh-kiro

<p align="center">
  <img src="assets/kiro-icon.svg" alt="Kiro" width="96" height="96">
</p>

English | [中文](README.zh.md)

Kiro provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with multi-method Kiro login, automatic token/profile refresh, live account model discovery, Claude/open-weight streaming, tool calls, and reasoning effort controls.

The bundle registers the `kiro` provider route and mounts itself when installed. No API key or manual `cordis.yml` entry is required.

This is an independent integration and is not affiliated with or endorsed by AWS or Kiro. Kiro and its logo are Amazon trademarks; see [NOTICE.md](NOTICE.md).

<p align="center">
  <img src="assets/settings-kiro.png" alt="Settings → Kiro: account status, credit usage, and the live model selector" width="820">
</p>

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
- Send images to every model whose catalog entry accepts them, which unlocks image attachments and the harness's own image-reading tool.
- Support direct egress or an authenticated HTTP/HTTPS `CONNECT` proxy.
- Hot-reload `llm-kiro` settings without restarting DSH.

## Sign in

### Web

Open **Settings → Kiro** and select a method:

- **AWS Builder ID** uses the standard device-code flow.
- **IAM Identity Center** uses a device flow with your `https://<company>.awsapps.com/start` URL and region.
- **Google / GitHub** uses Kiro's social device flow. The page shows a one-time `XXXX-XXXX` code and an `app.kiro.dev/account/device` authorization URL while the plugin waits for completion.
- **Refresh token**, **Kiro API key**, and **Microsoft external IdP JSON** validate/import an existing credential without exposing it back to the browser status API.
- An import reports what it actually verified: an API key is checked against the live model catalog first, so the page can say `Credential verified · 19 models available`. A refresh token reports verification because the exchange minted a real access token; external-IdP JSON is only reshaped locally, so it says `Credentials saved` rather than claiming a check that never happened. On success the dialog closes, the pasted secret is dropped from the page, and the usage card is re-read for the account that now applies.

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

### What this plugin does not do

It never compacts. As an adapter it owns the provider seam and nothing else: deciding what a conversation should contain belongs to `dsh-compaction-basic`, driven by the token meter and by the overflow code reported here. So the serializer repairs protocol shape — merging same-role runs, padding an alternation gap, carrying an orphaned tool result as text — but it never drops or condenses content to make a request fit. A conversation larger than the model's window is sent in full, the provider refuses it, and that refusal is what starts the harness's recovery. Trimming locally would discard turns the harness still believes it has, and would hide the overflow that triggers compaction.

The single exception is deliberate and narrow: a text block whose entire content is the legacy `[system: conversation continues]` padding this plugin itself once emitted is dropped when history is rebuilt, because replaying it teaches the model to reproduce it. That invariant is pinned by the "plugin boundary: the adapter never compacts" tests.

Responses arrive as `vnd.amazon.eventstream` frames. The adapter validates frame boundaries and CRCs, routes native `reasoningContentEvent` frames and legacy `<thinking>` runs into DSH reasoning blocks, preserves text blocks, decodes tool calls, and suppresses known open-weight prompt-format artifacts.

The terminal `metadataEvent` supplies the finish reason: `END_TURN`, `TOOL_USE`, `MAX_TOKENS`, `MODEL_CONTEXT_WINDOW_EXCEEDED`, `CONTENT_FILTERED`, and `PAUSE_TURN` map to the matching DSH outcome, and an unrecognized reason fails the turn with a diagnosable code instead of reporting success.

### Generation controls

`generateAssistantResponse` declares only `conversationState`, `profileArn`, the agent-mode header, `additionalModelRequestFields`, and `systemPrompt`. There is no `inferenceConfig`: a top-level generation object is accepted and then ignored by the service, which is why this adapter does not send one.

`additionalModelRequestFields` is validated against the schema each model publishes through `ListAvailableModels`, and that schema is `additionalProperties: false`. So the adapter sends only what the selected model advertises:

- Reasoning effort goes to `output_config.effort` or `reasoning.effort`, whichever branch the model declares.
- A requested `maxTokens` goes to `max_tokens`, clamped into the model's advertised `minimum`/`maximum` (currently 1024–128,000 on the newer Claude routes).
- Models that publish no schema at all receive no `additionalModelRequestFields`, because the member itself is refused for them.

Nothing else has an accepted placement. `temperature`, `topP`, and stop sequences are not part of this operation's contract — an unadvertised property is rejected outright — so those options are ignored rather than sent.

### Images

Every model whose catalog entry declares `supportedInputTypes: ["TEXT","IMAGE"]` accepts images — on the verified account that is 17 of 19, including all Claude routes, with `glm-5` and `minimax-m2.5` reporting text only. The capability is read from the catalog rather than guessed from the model id, so a route that gains or loses it needs no code change; `models[].inputModalities` overrides it when a tier disagrees, and a model that states nothing stays text-only because an unstated capability must not be assumed.

Kiro accepts png, jpeg, gif and webp. Images are re-encoded to at most 8000x8000 pixels and 3.75 MB before base64 expansion, matching the bounds of the service its models run behind, and travel as `userInputMessage.images` — `ImageBlock { format, source: { bytes } }`.

Only user turns have an image seat on this wire. The service's `AssistantResponseMessage` has none, so an image in replayed assistant history is refused rather than dropped, and `ToolResultContentBlock` is a union of text and json only, so an image returned by a tool is hoisted onto the user turn that carries its result — the nearest place that keeps it. Image bytes live in the harness's attachment service, so a profile that mounts none, or one older than that service's request-image encoder, reports images as unsupported instead of failing mid-request.

### Token accounting

Two signals exist, and the adapter prefers the exact one.

When `metadataEvent` carries `tokenUsage`, its counters map straight to DSH's native buckets: uncached input, output, cache reads, and cache writes, with no estimates or double-counting. `totalTokens` is used only to recover the uncached input when a route reports the total without that bucket.

Kiro does not send `tokenUsage` on every route — no observed request on this account received one. It does send `contextUsageEvent` on every request, and the wire schema treats `contextUsagePercentage` as part of token accounting, so when no buckets arrive the adapter prices the call from that percentage times the model's advertised context window. This matters beyond display: DSH's token meter anchors its context accounting on provider usage, and with none it prices the whole conversation from a local heuristic, so compaction thresholds drift. Both reference implementations convert the percentage the same way and for the same reason.

What that number is and is not: the input side is the provider's own measurement, at the precision the provider reported it, of how full the window is — not an exact per-request count. The output side has no provider signal at all and is scaled from the characters the stream emitted. Cache buckets are never invented; they appear only when Kiro reports them.

Cache buckets appear only when Kiro reports them, which no observed route does — so DSH shows `Cache hit 0%`, and that reads as "not reported" rather than "nothing was cached". Caching demonstrably happens: repeating a request with the same long prefix costs 0.0417 credits against 0.0787 for the first, a 47% reduction. Kiro does it server-side and keys it on the prefix, so resending history across a turn loop already benefits. The service simply does not send `cacheReadInputTokens`, and the adapter will not invent it.

Sending `cachePoint: {type: 'default'}` — which the service model declares on `UserInputMessage`, `AssistantResponseMessage`, and as a `Tool` union arm — is accepted but changes nothing: cold and warm credit costs are identical to 17 significant digits with and without it. `tests/live-cache.spec.ts` is that experiment, kept so the answer can be rechecked rather than reasoned about.

Account credit usage on the settings card is a separate, plan-level figure and is never converted into per-request token counts.

## Why some Claude routes need a proxy

Kiro can authorize model families by request egress as well as account entitlement. From an unauthorized egress a `claude-*` model may fail with `INVALID_MODEL` while open-weight routes work. `proxyUrl` provides the required egress when applicable. The adapter uses an HTTP `CONNECT` tunnel with TLS negotiated inside it, so the proxy sees the target hostname but not the bearer token or request body.

## Errors

The adapter maps provider failures to stable DSH codes: `AUTH`, `FORBIDDEN`, `RATE_LIMIT`, `INVALID_MODEL`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `ABORTED`, `TIMEOUT`, `STREAM_CLOSED`, `MALFORMED_RESPONSE`, and `EMPTY_RESPONSE`.

An exhausted plan is mapped to `QUOTA`: Kiro reports it as HTTP 402, and sometimes as a 403 or a throttle whose reason names the monthly or daily allowance (`MONTHLY_REQUEST_COUNT`, `CREDIT_CONSUMPTION_RATE_EXCEEDED`). Retrying cannot help, so it must not read as a rate limit or a permission problem.

A request Kiro rejects for exceeding its content bound is mapped to `CONTEXT_WINDOW_EXCEEDED` — matched from its `CONTENT_LENGTH_EXCEEDS_THRESHOLD` validation reason and the `Input is too long.` / `Prompt is too long.` wording its own client recognizes. That specific code is what makes DSH run emergency compaction and retry the turn; every other HTTP 400 stays `INVALID_REQUEST`, because compacting cannot fix a malformed request.

## Development

```sh
npm install
npm run check
npm run pack:dist
```

`npm run check` type-checks, runs the keyless Vitest suite, rebuilds committed artifacts, and syntax-checks the web client and login CLI.

Three `tests/live-*.spec.ts` probes talk to the signed-in Kiro account and are skipped unless `KIRO_LIVE=1` is set. They record which stream frames a real request produces, confirm how an oversized request is classified, and run a two-turn tool loop. Use them to re-verify the wire contract against a live account rather than against fixtures:

```sh
KIRO_LIVE=1 KIRO_MODEL=claude-opus-5 KIRO_EFFORT=high npx vitest run tests/live-frames.spec.ts
```

`tests/session-replay.spec.ts` (`DSH_SESSIONS=1`) replays the local DSH session store through the serializer, and `verification/` holds a credit-free harness that proves a context-overflow failure from this adapter makes DSH compact and retry the turn.

## Known limitations

- Image content is currently rejected with `UNSUPPORTED_CONTENT`.
- `temperature`, `topP`, and stop sequences have no accepted placement in Kiro's `generateAssistantResponse` request and are ignored.
- Tool names must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`.
- SOCKS proxies are not supported.

## Acknowledgements

The Kiro transport foundation is derived under MIT from [caopu16/dsh-llm-kiro](https://github.com/caopu16/dsh-llm-kiro). Login, profile-ARN, API-key, and external-IdP behavior was cross-checked against [decolua/9router](https://github.com/decolua/9router) and [dat-lequoc/Kiro-Go](https://github.com/dat-lequoc/Kiro-Go). The DSH Web integration follows the installable-bundle pattern demonstrated by [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity). Original copyright notices are retained in [LICENSE](LICENSE).

## License

MIT
