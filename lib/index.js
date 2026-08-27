import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy, userAgent } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { request as request$1 } from "node:https";
import { connect } from "node:tls";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import "@deepseek-ai/dsh-host-webserver";

//#region lib/types/eventstream.js
/** Bytes before the headers: total length, header length, prelude CRC. */
const PRELUDE_BYTES = 12;
/** Bytes after the payload holding the message CRC. */
const MESSAGE_CRC_BYTES = 4;
/** Header value type tag for a UTF-8 string, the only type Kiro sends. */
const HEADER_TYPE_STRING = 7;
/**
* Largest frame this decoder will buffer. AWS caps event-stream messages at
* 16 MiB, so a larger declared length is a desynchronized stream rather than
* a big message, and refusing it bounds memory instead of buffering forever.
*/
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/**
* Decode one frame's headers.
* @param buffer - the whole buffered stream.
* @param start - offset of the first header byte.
* @param end - offset one past the last header byte.
* @returns the header name/value pairs.
* @throws `LlmError('MALFORMED_RESPONSE')` on a non-string header value type.
*/
function decodeHeaders(buffer, start, end) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const decoder = new TextDecoder();
	const headers$1 = {};
	let offset = start;
	while (offset < end) {
		const nameLength = view.getUint8(offset);
		offset += 1;
		const name$1 = decoder.decode(buffer.subarray(offset, offset + nameLength));
		offset += nameLength;
		const type = view.getUint8(offset);
		offset += 1;
		if (type !== HEADER_TYPE_STRING) throw new LlmError(`Kiro event-stream header "${name$1}" has unsupported value type ${type}`, "MALFORMED_RESPONSE");
		const valueLength = view.getUint16(offset);
		offset += 2;
		headers$1[name$1] = decoder.decode(buffer.subarray(offset, offset + valueLength));
		offset += valueLength;
	}
	return headers$1;
}
/**
* Decode a byte stream into whole event-stream frames.
*
* A stream that ends mid-frame is truncation, not a flushable tail: the
* response cannot be trusted, so it raises rather than yielding a partial
* frame.
* @param stream - raw response bytes; reads may split anywhere, including
*   inside a prelude, header, or payload. Any async iterable of byte chunks
*   works, so the same decoder serves a `fetch` body and a Node response.
* @param onActivity - optional transport-activity callback invoked for each
*   read, so an idle watchdog can distinguish a slow model from a dead socket.
* @returns each complete frame in arrival order.
* @throws `LlmError('STREAM_CLOSED')` when the stream ends mid-frame, or
*   `LlmError('MALFORMED_RESPONSE')` on an implausible declared frame length.
*/
async function* decodeFrames(stream, onActivity) {
	let buffered = new Uint8Array(0);
	for await (const chunk of stream) {
		onActivity?.();
		const next = new Uint8Array(buffered.length + chunk.length);
		next.set(buffered);
		next.set(chunk, buffered.length);
		buffered = next;
		while (buffered.length >= PRELUDE_BYTES) {
			const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
			const totalLength = view.getUint32(0);
			const headerLength = view.getUint32(4);
			if (totalLength > MAX_FRAME_BYTES || totalLength < PRELUDE_BYTES + headerLength + MESSAGE_CRC_BYTES) throw new LlmError(`Kiro event-stream frame declares an implausible length of ${totalLength} bytes`, "MALFORMED_RESPONSE");
			if (buffered.length < totalLength) break;
			const headerEnd = PRELUDE_BYTES + headerLength;
			yield {
				headers: decodeHeaders(buffered, PRELUDE_BYTES, headerEnd),
				payload: buffered.subarray(headerEnd, totalLength - MESSAGE_CRC_BYTES)
			};
			buffered = buffered.subarray(totalLength);
		}
	}
	if (buffered.length > 0) throw new LlmError(`Kiro event stream ended with ${buffered.length} bytes of an incomplete frame`, "STREAM_CLOSED");
}

//#endregion
//#region lib/types/serialize.js
/** Request origin Kiro attributes IDE traffic to. */
const ORIGIN = "AI_EDITOR";
/**
* Neutral user text standing in for an absent turn. Matches the installed Kiro
* client's own `CONTINUE_MESSAGE_CONTENT`: ordinary conversational filler the
* model has no reason to imitate as output.
*/
const CONTINUE_PADDING = "Continue";
/**
* Neutral assistant text standing in for a turn with no prose of its own —
* the installed Kiro client's `UNDERSTOOD_MESSAGE` content.
*/
const ACKNOWLEDGE_PADDING = "understood";
/**
* The distinctive placeholder earlier versions used for structural padding.
* It looked like an injected system message, so the model imitated it and DSH
* persisted the imitation as visible assistant output. Sessions recorded before
* the fix still contain it, so replayed history is scrubbed of exact matches
* rather than replaying them into the model's context again.
*/
const LEGACY_CONTINUATION$1 = "[system: conversation continues]";
/** Content for a user turn that carries only tool results. */
const TOOL_RESULTS_ONLY = "Tool results provided.";
/** Tool names CodeWhisperer accepts verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Maximum thinking length published for each effort, in tokens. */
const THINKING_BUDGETS = {
	low: 4e3,
	medium: 12e3,
	high: 24e3
};
/**
* Validate the adapter-owned effort.
* @param effort - the request's opaque effort identifier.
* @returns the same value, narrowed.
* @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` for any other value.
*/
function narrowLegacyEffort(effort) {
	if (effort === "off" || effort === "low" || effort === "medium" || effort === "high") return effort;
	throw new LlmError(`Kiro does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
* Resolve the effort governing one request.
* @param options - the harness request.
* @param defaults - adapter-level defaults.
* @returns the effort, or `off` when thinking is not in play.
* @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` when a deployment that
*   disabled thinking is asked to enable it.
*/
function resolveEffort(options, defaults, native) {
	if (options.purpose === "session-title") return void 0;
	const requested = options.reasoningEffort === void 0 ? defaults.reasoningEffort ?? native?.defaultLevel : String(options.reasoningEffort);
	if (defaults.thinking === "disabled" && requested !== void 0 && requested !== "off" && requested !== "none") throw new LlmError(`Kiro deployment does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
	if (defaults.thinking === "disabled") return void 0;
	if (native !== void 0) {
		if (requested === void 0) return void 0;
		if (!native.levels.includes(requested)) throw new LlmError(`Kiro model does not advertise reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
		return requested;
	}
	return requested === void 0 ? "off" : narrowLegacyEffort(requested);
}
/**
* Build the system text Kiro sees, including thinking markers.
* @param options - the harness request.
* @param effort - the resolved effort.
* @returns the system text, empty when there is nothing to say.
*/
function systemText(options, effort, native) {
	const persona = options.system ?? "";
	if (effort === void 0 || effort === "off" || effort === "none" || native !== void 0) return persona;
	const legacyEffort = narrowLegacyEffort(effort);
	if (legacyEffort === "off") return persona;
	const markers = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGETS[legacyEffort]}</max_thinking_length>`;
	return persona.length === 0 ? markers : `${markers}\n${persona}`;
}
/** Build Kiro's model-specific native effort object. */
function buildEffortRequestFields(effort, native) {
	if (effort === void 0 || native === void 0) return void 0;
	return native.schemaPath === "output_config" ? { output_config: { effort } } : { reasoning: { effort } };
}
/**
* Build `additionalModelRequestFields` for one request.
*
* This is the only place `generateAssistantResponse` accepts generation
* controls: its request shape declares `conversationState`, `profileArn`,
* `agentMode`, `additionalModelRequestFields`, and `systemPrompt` and nothing
* else, so a top-level `inferenceConfig` is silently dropped by the service.
* The object is validated against each model's advertised schema, which is
* `additionalProperties: false`, and a model that advertises no schema rejects
* the member outright — so nothing may be sent speculatively:
*
* - unadvertised property → HTTP 400 `property 'x' is not defined in the schema`
* - model with no schema → HTTP 400 `additionalModelRequestFields is not supported for this model`
*
* @param effort - the resolved reasoning effort, when the model takes one.
* @param native - the model's live effort contract, absent when it has no schema.
* @param maxTokens - the caller's requested output cap, if any.
* @param limits - the model's advertised field bounds.
* @returns the object to send, or `undefined` when there is nothing valid to send.
* @throws `LlmError('INVALID_REQUEST')` for an unusable caller value.
*/
function buildModelRequestFields(effort, native, maxTokens, limits) {
	if (native === void 0) return void 0;
	const fields = { ...buildEffortRequestFields(effort, native) };
	if (maxTokens !== void 0) {
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new LlmError(`Kiro requires a positive integer maxTokens; received ${String(maxTokens)}`, "INVALID_REQUEST");
		const bounds = limits?.maxTokensBounds;
		if (bounds !== void 0) fields.max_tokens = Math.min(Math.max(maxTokens, bounds.minimum), bounds.maximum);
	}
	return Object.keys(fields).length === 0 ? void 0 : fields;
}
/**
* Join the text blocks of one message, dropping blocks that are nothing but an
* exact legacy continuation marker.
*
* Sessions recorded before the padding fix persisted the marker as whole
* assistant text blocks; replaying them teaches the model the phrase again and
* multiplies it through history. Only a block whose entire text is the marker is
* dropped, so a message discussing the phrase in prose keeps it verbatim.
*/
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").filter((block) => block.text.trim() !== LEGACY_CONTINUATION$1).map((block) => block.text).join("");
}
/**
* Reject images in a role whose wire message has nowhere to put them.
* @param blocks - blocks from one message.
* @param role - the role being serialized, named in the error.
* @throws `LlmError('UNSUPPORTED_CONTENT')` when the role carries an image.
*/
function assertNoImages(blocks, role) {
	if (contentHasImage(blocks)) throw new LlmError(`Kiro accepts images only on user turns; this request has one on a ${role} turn.`, "UNSUPPORTED_CONTENT");
}
/**
* Collect the wire images for one user message, in content order.
*
* Images nested in a tool result are hoisted onto the same user turn: the
* service's `ToolResultContentBlock` is a union of text and json only, so a
* screenshot returned by a tool has no seat of its own, and the enclosing turn
* is the nearest place that preserves it rather than discarding it.
* @param blocks - blocks from one user message.
* @param prepared - wire images already read for this request.
* @returns wire image blocks in the order they appear.
* @throws `LlmError('INVALID_REQUEST')` when a block was never prepared.
*/
function imagesOf(blocks, prepared) {
	const images = [];
	const walk = (content) => {
		for (const block of content) if (block.type === "image") {
			const image = prepared.get(block.attachment.attachmentId);
			if (image === void 0) throw new LlmError(`Kiro request image ${block.attachment.attachmentId} was not prepared.`, "INVALID_REQUEST");
			images.push(image);
		} else if (block.type === "tool-result") walk(block.content);
	};
	walk(blocks);
	return images;
}
/**
* Validate one tool name against the wire pattern.
* @param name - the harness tool name.
* @returns the same name.
* @throws `LlmError('UNSUPPORTED_TOOL_NAME')` when Kiro would reject it.
*/
function assertToolName(name$1) {
	if (!TOOL_NAME_PATTERN.test(name$1)) throw new LlmError(`Kiro rejects tool name "${name$1}"; names must match ${String(TOOL_NAME_PATTERN)}`, "UNSUPPORTED_TOOL_NAME");
	return name$1;
}
/** Serialize the tool-result blocks of one message. */
function toolResultsOf(message) {
	return message.content.filter((block) => block.type === "tool-result").map((block) => ({
		toolUseId: block.toolCallId,
		content: [{ text: flattenText(block.content) || "(no output)" }],
		status: block.isError === true ? "error" : "success"
	}));
}
/** Serialize the tool-call blocks of one assistant message. */
function toolUsesOf(message) {
	return message.content.filter((block) => block.type === "tool-call").map((block) => ({
		toolUseId: block.id,
		name: assertToolName(block.name),
		input: parseArguments(block.arguments)
	}));
}
/**
* Parse tool-call arguments into the object Kiro expects.
* @param raw - the model's raw JSON argument string.
* @returns the parsed value, or an empty object when the model emitted
*   nothing or invalid JSON — replaying history must not fail a live request
*   over a malformed past call.
*/
function parseArguments(raw) {
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
/**
* Fold the harness conversation into alternating user and assistant turns.
* Consecutive same-role messages merge, because Kiro accepts only strict
* alternation.
* @param messages - the harness conversation, in order.
* @returns the folded turns, each tagged with its role.
*/
function foldTurns(messages, images) {
	const turns = [];
	for (const message of messages) {
		const text$3 = flattenText(message.content);
		if (message.role === "assistant") {
			assertNoImages(message.content, "assistant");
			const toolUses = toolUsesOf(message);
			const last$1 = turns.at(-1);
			if (last$1?.role === "assistant") {
				last$1.text = [last$1.text, text$3].filter((part) => part.length > 0).join("\n\n");
				last$1.toolUses = [...last$1.toolUses, ...toolUses];
				continue;
			}
			turns.push({
				role: "assistant",
				text: text$3,
				toolUses
			});
			continue;
		}
		const toolResults = toolResultsOf(message);
		const turnImages = imagesOf(message.content, images);
		const last = turns.at(-1);
		if (last?.role === "user") {
			last.turn.text = [last.turn.text, text$3].filter((part) => part.length > 0).join("\n\n");
			last.turn.toolResults = [...last.turn.toolResults, ...toolResults];
			last.turn.images = [...last.turn.images, ...turnImages];
			continue;
		}
		turns.push({
			role: "user",
			turn: {
				text: text$3,
				toolResults,
				images: turnImages
			}
		});
	}
	return turns;
}
/**
* Build one wire user message.
* @param turn - the folded user turn.
* @param model - the wire model id, repeated on every user turn.
* @param context - optional per-turn context (tools, tool results).
* @returns the wire message.
*/
function userMessage(turn, model, context) {
	return {
		content: turn.text.length > 0 ? turn.text : turn.toolResults.length > 0 ? TOOL_RESULTS_ONLY : CONTINUE_PADDING,
		modelId: model,
		origin: ORIGIN,
		...context === void 0 ? {} : { userInputMessageContext: context },
		...turn.images.length === 0 ? {} : { images: turn.images }
	};
}
/**
* Build the complete wire request.
*
* The final user turn becomes `currentMessage` and carries the tool schemas;
* everything before it becomes alternating history. A conversation whose last
* turn is the assistant's (a resumed session, a compaction boundary) gets a
* neutral continuation user turn so there is something to answer.
* @param options - the harness request.
* @param defaults - adapter-level thinking defaults.
* @param conversationId - identifier for this request's conversation.
* @param profileArn - CodeWhisperer profile the account bills against.
* @param nativeEffort - live effort levels and their provider request path.
* @param limits - live per-model generation bounds, when discovery supplied them.
* @param images - wire images already read for this request, by attachment id.
* @returns the request body.
* @throws `LlmError` when an image cannot be placed, a tool name is unusable,
*   an effort is unsupported, a generation option is unusable, or there are no
*   messages at all.
*/
function serializeRequest(options, defaults, conversationId, profileArn, nativeEffort, limits, images = /* @__PURE__ */ new Map()) {
	if (options.messages.length === 0) throw new LlmError("Kiro requires at least one message", "INVALID_REQUEST");
	const effort = resolveEffort(options, defaults, nativeEffort);
	const turns = foldTurns(options.messages, images);
	if (turns.at(-1)?.role === "assistant") turns.push({
		role: "user",
		turn: {
			text: CONTINUE_PADDING,
			toolResults: [],
			images: []
		}
	});
	const current = turns.pop();
	/* v8 ignore next -- a non-empty conversation always folds to at least one turn */
	if (current === void 0 || current.role !== "user") throw new LlmError("Kiro request has no user turn to answer", "INVALID_REQUEST");
	const history = [];
	for (const entry of turns) {
		const expected = history.length % 2 === 0 ? "user" : "assistant";
		if (entry.role !== expected) history.push(expected === "user" ? { userInputMessage: userMessage({
			text: CONTINUE_PADDING,
			toolResults: [],
			images: []
		}, options.model) } : { assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } });
		if (entry.role === "user") {
			history.push({ userInputMessage: userMessage(entry.turn, options.model, entry.turn.toolResults.length > 0 ? { toolResults: entry.turn.toolResults } : void 0) });
			continue;
		}
		history.push({ assistantResponseMessage: {
			content: entry.text.length > 0 ? entry.text : ACKNOWLEDGE_PADDING,
			...entry.toolUses.length > 0 ? { toolUses: entry.toolUses } : {}
		} });
	}
	if (history.length % 2 !== 0) history.push({ assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } });
	const issued = new Set(history.flatMap((entry) => "assistantResponseMessage" in entry ? (entry.assistantResponseMessage.toolUses ?? []).map((use) => use.toolUseId) : []));
	const matched = current.turn.toolResults.filter((result) => issued.has(result.toolUseId));
	const text$3 = current.turn.toolResults.filter((result) => !issued.has(result.toolUseId)).reduce((accumulated, result) => `${accumulated}\n\n[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ""}`, current.turn.text);
	const tools = (options.tools ?? []).map((tool) => ({ toolSpecification: {
		name: assertToolName(tool.name),
		description: tool.description,
		inputSchema: { json: tool.parameters }
	} }));
	const system = systemText(options, effort, nativeEffort);
	const currentMessage = userMessage({
		text: text$3,
		toolResults: matched,
		images: current.turn.images
	}, options.model, tools.length > 0 || matched.length > 0 ? {
		...tools.length > 0 ? { tools } : {},
		...matched.length > 0 ? { toolResults: matched } : {}
	} : void 0);
	if (system.length > 0) {
		const first = history.find((entry) => "userInputMessage" in entry);
		if (first === void 0) currentMessage.content = `${system}\n\n${currentMessage.content}`;
		else first.userInputMessage.content = `${system}\n\n${first.userInputMessage.content}`;
	}
	const additionalModelRequestFields = buildModelRequestFields(effort, nativeEffort, options.maxTokens, limits);
	return {
		...profileArn === void 0 ? {} : { profileArn },
		...additionalModelRequestFields === void 0 ? {} : { additionalModelRequestFields },
		conversationState: {
			chatTriggerType: "MANUAL",
			conversationId,
			currentMessage: { userInputMessage: currentMessage },
			...history.length > 0 ? { history } : {}
		}
	};
}

//#endregion
//#region lib/types/region.js
/** Validation for AWS region values used to construct Kiro hostnames. */
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u;
/**
* Normalize an AWS region before using it in an outbound hostname.
* @param value - configured or credential-derived region.
* @returns validated lowercase region.
*/
function assertKiroRegion(value) {
	const region = value.trim().toLowerCase();
	if (!REGION.test(region)) throw new Error(`dsh-kiro: invalid AWS region "${value}"`);
	return region;
}

//#endregion
//#region lib/types/endpoint.js
/**
* The only endpoints the installed Kiro CLI knows. Its `chat-cli` keeps exactly
* this table and resolves the account profile region against it, falling back
* to the default endpoint for any other region. `q.<region>.amazonaws.com` has
* DNS records only in these two regions: the older `codewhisperer.<region>`
* spelling is an alias of the us-east-1 host and exists nowhere else, so a
* credential whose SSO region is different (for example an IAM Identity Center
* instance in `ap-southeast-1`) must not derive its request host from that
* region — the hostname simply does not exist.
*/
const KIRO_ENDPOINTS = [{
	region: "us-east-1",
	url: "https://q.us-east-1.amazonaws.com"
}, {
	region: "eu-central-1",
	url: "https://q.eu-central-1.amazonaws.com"
}];
const DEFAULT_ENDPOINT = {
	region: "us-east-1",
	url: "https://q.us-east-1.amazonaws.com"
};
/**
* Resolve the Kiro API endpoint for one region.
* @param region - any validated AWS region. The credential's recorded region is
*   the SSO region and is often not a service region.
* @returns the published endpoint serving that region, or the default endpoint.
*/
function kiroApiEndpoint(region) {
	const normalized = assertKiroRegion(region);
	return KIRO_ENDPOINTS.find((endpoint) => endpoint.region === normalized) ?? DEFAULT_ENDPOINT;
}

//#endregion
//#region lib/types/transport.js
/** Default port for each supported proxy scheme. */
const PROXY_PORTS = {
	"http:": 80,
	"https:": 443
};
/**
* Validate a proxy URL at its configuration boundary.
* @param raw - the configured proxy URL.
* @returns the parsed URL.
* @throws when the value is not a URL, or names a scheme this transport cannot open.
*/
function parseProxyUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch (error) {
		throw new Error(`llm-kiro: proxyUrl "${raw}" is not a valid URL`, { cause: error });
	}
	if (!(url.protocol in PROXY_PORTS)) throw new Error(`llm-kiro: proxyUrl scheme "${url.protocol}" is not supported; use http:// or https://`);
	if (url.hostname.length === 0) throw new Error(`llm-kiro: proxyUrl "${raw}" names no host`);
	return url;
}
/**
* Open a `CONNECT` tunnel to `host:port` through an HTTP proxy.
* @param proxy - the validated proxy URL.
* @param host - target hostname.
* @param port - target port.
* @param signal - caller cancellation.
* @returns the tunneled socket, ready for TLS.
* @throws `LlmError('TRANSPORT')` when the proxy refuses or the connection fails.
*/
function openTunnel(proxy, host, port, signal) {
	return new Promise((resolve, reject) => {
		const request$2 = (proxy.protocol === "https:" ? request$1 : request)({
			host: proxy.hostname,
			port: proxy.port.length > 0 ? Number(proxy.port) : PROXY_PORTS[proxy.protocol],
			method: "CONNECT",
			path: `${host}:${port}`,
			signal,
			headers: {
				host: `${host}:${port}`,
				...proxy.username.length > 0 ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}
			}
		});
		request$2.once("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new LlmError(`Kiro proxy ${proxy.host} refused CONNECT with HTTP ${String(response.statusCode)}`, "TRANSPORT"));
				return;
			}
			resolve(socket);
		});
		request$2.once("error", (error) => {
			reject(new LlmError(`Kiro proxy ${proxy.host} connection failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end();
	});
}
/**
* POST one request and resolve as soon as response headers arrive, so the
* caller streams the body itself.
* @param options - target, headers, body, cancellation, and optional proxy.
* @returns status, headers, and the body byte stream.
* @throws `LlmError('TRANSPORT')` on a pre-response transport failure, or
*   `LlmError('ABORTED')` when the caller cancelled first.
*/
async function send(options) {
	const target = new URL(options.url);
	const port = target.port.length > 0 ? Number(target.port) : 443;
	const tunnel = options.proxyUrl === void 0 ? void 0 : await openTunnel(parseProxyUrl(options.proxyUrl), target.hostname, port, options.signal);
	return new Promise((resolve, reject) => {
		const request$2 = request$1({
			host: target.hostname,
			port,
			path: `${target.pathname}${target.search}`,
			method: options.method,
			signal: options.signal,
			...tunnel === void 0 ? {} : { createConnection: () => connect({
				socket: tunnel,
				servername: target.hostname
			}) },
			headers: {
				...options.headers,
				...options.body === void 0 ? {} : { "content-length": String(Buffer.byteLength(options.body)) }
			}
		}, (response) => {
			resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: response
			});
		});
		request$2.once("error", (error) => {
			tunnel?.destroy();
			if (options.signal.aborted) {
				reject(new LlmError("Kiro request aborted by caller", "ABORTED", { cause: error }));
				return;
			}
			reject(new LlmError(`Kiro request to ${target.host} failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end(options.body);
	});
}
function post(options) {
	return send({
		...options,
		method: "POST"
	});
}
async function responseJson(response) {
	const chunks = [];
	for await (const chunk of response.body) chunks.push(chunk);
	const text$3 = Buffer.concat(chunks).toString("utf8");
	try {
		return {
			status: response.status,
			body: JSON.parse(text$3)
		};
	} catch {
		return {
			status: response.status,
			body: void 0
		};
	}
}
/**
* POST JSON and read the whole response, for the small non-streaming calls
* (token refresh) that share this transport's egress.
* @param url - absolute `https:` URL.
* @param body - value serialized as the JSON request body.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns the status and parsed JSON body; an unparsable body resolves as `undefined`.
*/
async function postJson(url, body, proxyUrl, signal) {
	return postJsonWithHeaders(url, body, {}, proxyUrl, signal);
}
/**
* POST and parse JSON while supplying operation-specific headers.
* @param url - absolute HTTPS URL.
* @param body - JSON request value.
* @param headers - extra request headers such as Kiro authorization.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns status and parsed response body.
*/
async function postJsonWithHeaders(url, body, headers$1, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			...headers$1
		},
		body: JSON.stringify(body),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}
/** POST an OAuth form and parse its small JSON response. */
async function postForm(url, body, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json"
		},
		body: body.toString(),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}
/**
* GET and parse a small JSON response through the same optional proxy.
* @param url - absolute HTTPS URL.
* @param headers - request headers.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns status and parsed response body.
*/
async function getJson(url, headers$1, proxyUrl, signal) {
	return responseJson(await send({
		url,
		method: "GET",
		headers: {
			accept: "application/json",
			...headers$1
		},
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}

//#endregion
//#region lib/types/translate.js
/** Opens Kiro's in-band thinking channel. */
const THINKING_OPEN = "<thinking>";
/** Closes Kiro's in-band thinking channel. */
const THINKING_CLOSE = "</thinking>";
/**
* Tool-call preamble the open-weight routes leak into the text channel. It is
* an artifact of their prompt format, never content the user should read, and
* the real call always follows as a `toolUseEvent`.
*/
const DSML_MARKER = "<｜DSML｜";
/**
* The structural padding earlier versions sent as history. Enough of it reached
* the model that it learned to answer with the phrase verbatim; sessions still
* replay those answers. Serialization no longer produces it, and a response
* that is nothing but the marker is suppressed here so the last contaminated
* turns cannot surface as visible assistant output.
*/
const LEGACY_CONTINUATION = "[system: conversation continues]";
/**
* Withhold a visible response that may turn out to be nothing but the legacy
* continuation marker.
*
* Only an exact standalone marker is suppressed. Text is held back only while
* everything seen so far is still a prefix of the marker, so ordinary prose —
* including prose that discusses the phrase — is released as soon as it
* diverges and is never altered.
*/
var LegacyMarkerGuard = class {
	pending = "";
	settled = false;
	/**
	* Filter one visible run.
	* @param text - the run exactly as the router produced it.
	* @returns the text that can be emitted now, empty while undecided.
	*/
	push(text$3) {
		if (this.settled) return text$3;
		this.pending += text$3;
		const trimmed = this.pending.trim();
		if (trimmed.length === 0 || LEGACY_CONTINUATION.startsWith(trimmed)) return "";
		this.settled = true;
		const released = this.pending;
		this.pending = "";
		return released;
	}
	/**
	* Resolve the withheld text when the stream ends.
	* @returns the withheld text, or nothing when it was exactly the marker.
	*/
	flush() {
		if (this.settled) return "";
		const pending = this.pending;
		this.pending = "";
		this.settled = true;
		return pending.trim() === LEGACY_CONTINUATION ? "" : pending;
	}
};
/**
* Length of the longest suffix of `buffer` that is a proper prefix of any
* watched token. That tail must be held back: it may complete into a marker
* on the next frame.
* @param buffer - the unrouted text.
* @param tokens - markers being watched in the current channel.
* @returns the number of trailing characters to withhold.
*/
function heldSuffixLength(buffer, tokens) {
	const longest = Math.max(...tokens.map((token) => token.length));
	for (let length = Math.min(longest - 1, buffer.length); length > 0; length -= 1) {
		const suffix = buffer.slice(buffer.length - length);
		if (tokens.some((token) => token.startsWith(suffix))) return length;
	}
	return 0;
}
/**
* Routes Kiro's single text channel into harness text and reasoning runs.
*
* Marker recognition is stateful across frames, which is the point: a delta
* boundary inside `</thinking>` must not surface the tag as visible output.
*/
var TextRouter = class {
	channel = "text";
	buffer = "";
	/** Markers that end the current channel's run. */
	get watched() {
		switch (this.channel) {
			case "text": return [THINKING_OPEN, DSML_MARKER];
			case "reasoning": return [THINKING_CLOSE];
			case "suppressed": return [];
		}
	}
	/**
	* Route one text delta.
	* @param delta - text exactly as the frame carried it.
	* @returns the runs that can be emitted now, in order; a delta ending
	*   mid-marker contributes nothing until the marker resolves.
	*/
	push(delta) {
		if (this.channel === "suppressed") return [];
		this.buffer += delta;
		const routed = [];
		while (true) {
			const watched = this.watched;
			if (watched.length === 0) {
				this.buffer = "";
				return routed;
			}
			const hit = watched.map((token) => ({
				token,
				at: this.buffer.indexOf(token)
			})).filter((candidate) => candidate.at >= 0).sort((left, right) => left.at - right.at)[0];
			if (hit === void 0) break;
			const before = this.buffer.slice(0, hit.at);
			if (before.length > 0 && this.channel !== "suppressed") routed.push({
				channel: this.channel,
				text: before
			});
			this.buffer = this.buffer.slice(hit.at + hit.token.length);
			this.channel = hit.token === THINKING_OPEN ? "reasoning" : hit.token === THINKING_CLOSE ? "text" : "suppressed";
		}
		if (this.channel === "suppressed") return routed;
		const held = heldSuffixLength(this.buffer, this.watched);
		const emit = this.buffer.slice(0, this.buffer.length - held);
		this.buffer = this.buffer.slice(this.buffer.length - held);
		if (emit.length > 0) routed.push({
			channel: this.channel,
			text: emit
		});
		return routed;
	}
	/**
	* Release text withheld as a possible partial marker.
	* @returns the final run, or nothing when the buffer is empty or suppressed.
	*/
	flush() {
		if (this.channel === "suppressed" || this.buffer.length === 0) return [];
		const text$3 = this.buffer;
		this.buffer = "";
		return [{
			channel: this.channel,
			text: text$3
		}];
	}
};
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Parse one frame payload as JSON.
* @param frame - the decoded frame.
* @returns the parsed event.
* @throws `LlmError('MALFORMED_RESPONSE')` when the payload is not JSON.
*/
function parsePayload(frame) {
	const text$3 = new TextDecoder().decode(frame.payload);
	try {
		return JSON.parse(text$3);
	} catch {
		throw new LlmError(`malformed Kiro event payload: ${text$3.slice(0, 120)}`, "MALFORMED_RESPONSE");
	}
}
/** Accept one provider counter only when it is safe for DSH's usage schema. */
function tokenCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
/**
* Convert Kiro's disjoint token buckets to DSH's native usage vocabulary.
*
* Missing counters are zero, matching Kiro CLI's own stream parser, and a
* present malformed counter rejects the event instead of publishing misleading
* data. `totalTokens` is used only to recover the uncached input when the
* provider reports the total without that bucket. An event with no non-zero
* counter publishes nothing at all: usage DSH never received must read as
* unavailable, not as zero.
*/
function tokenUsageOf(value) {
	if (value === void 0 || typeof value !== "object" || value === null) return void 0;
	if ([
		value.uncachedInputTokens,
		value.outputTokens,
		value.totalTokens,
		value.cacheReadInputTokens,
		value.cacheWriteInputTokens
	].some((field) => field !== void 0 && tokenCount(field) === void 0)) return void 0;
	const outputTokens = tokenCount(value.outputTokens) ?? 0;
	const cacheReadTokens = tokenCount(value.cacheReadInputTokens) ?? 0;
	const cacheWriteTokens = tokenCount(value.cacheWriteInputTokens) ?? 0;
	const total = tokenCount(value.totalTokens);
	const inputTokens = tokenCount(value.uncachedInputTokens) ?? (total === void 0 ? 0 : Math.max(0, total - outputTokens - cacheReadTokens - cacheWriteTokens));
	if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return;
	return {
		inputTokens,
		outputTokens,
		...cacheReadTokens > 0 ? { cacheReadTokens } : {},
		...cacheWriteTokens > 0 ? { cacheWriteTokens } : {}
	};
}
/**
* Price one call from the provider's own context measurement.
*
* Kiro does not send `metadataEvent.tokenUsage` on every route — this account's
* traffic never received one — but it does send `contextUsageEvent` on every
* request, and the wire schema treats `contextUsagePercentage` as part of token
* accounting. Scaling it by the model's advertised window recovers the absolute
* input size, which is what the harness needs to know how full the window is:
* without any usage the token meter has no provider anchor and prices the whole
* conversation from a local heuristic, so its compaction thresholds drift.
*
* Both local reference implementations do exactly this, for the same stated
* reason (`Kiro-Go/proxy/kiro.go:766`, `9router/open-sse/executors/kiro.js:1086`).
* The result is the provider's own measurement at the precision the provider
* reported it, not an exact per-request count: the output side has no such
* signal and is priced from the characters this stream actually emitted.
* @param percentage - the last `contextUsagePercentage` the stream reported.
* @param contextWindow - the selected model's advertised input capacity.
* @param outputCharacters - characters emitted as visible text and reasoning.
* @returns derived usage, or `undefined` when either input is unusable.
*/
function contextUsageTokens(percentage$1, contextWindow, outputCharacters) {
	if (percentage$1 === void 0 || contextWindow === void 0) return void 0;
	if (!Number.isFinite(percentage$1) || percentage$1 <= 0 || percentage$1 > 100) return void 0;
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) return void 0;
	const inputTokens = Math.round(percentage$1 / 100 * contextWindow);
	if (inputTokens <= 0) return void 0;
	return {
		inputTokens,
		outputTokens: outputCharacters > 0 ? Math.max(1, Math.round(outputCharacters / 4)) : 0
	};
}
/**
* Normalize a provider stop reason for comparison.
*
* Kiro's `StopReason` enum is upper snake case, while its lifecycle and proxy
* vocabularies use lower snake or camel case for the same outcomes. One
* normalized form keeps the mapping table small and case-independent.
* @param reason - the raw provider value.
* @returns the upper snake-case form.
*/
function normalizeStopReason(reason) {
	return reason.trim().replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[\s-]+/gu, "_").toUpperCase();
}
/** Render the refusal detail Kiro attaches to a filtered or declined turn. */
function refusalDetail(details) {
	const refusal = details?.refusal;
	if (refusal === void 0) return "";
	const parts = [
		refusal.category,
		refusal.explanation,
		refusal.recommendedModel
	].filter((part) => typeof part === "string" && part.length > 0);
	return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}
/**
* Map one provider stop reason to the harness finish reason.
*
* Terminal protocol semantics are the provider's to state: a turn cut off by an
* output cap, an exhausted context, or a refusal must not be reported as a
* normal completion. An unrecognized reason stays a diagnosable failure rather
* than becoming a silent success, because a new terminal reason is exactly the
* case where guessing `stop` loses information.
* @param reason - the raw `metadataEvent.stopReason`.
* @param details - the accompanying `stopDetails`, when present.
* @param sawToolCalls - whether the stream opened any tool call.
* @returns the finish reason, or `undefined` when the provider named none.
*/
function finishReasonOf(reason, details, sawToolCalls) {
	if (reason === void 0 || reason.trim().length === 0) return void 0;
	switch (normalizeStopReason(reason)) {
		case "END_TURN":
		case "STOP":
		case "STOP_SEQUENCE": return sawToolCalls ? { kind: "tool-calls" } : { kind: "stop" };
		case "TOOL_USE":
		case "TOOL_CALLS": return { kind: "tool-calls" };
		case "MAX_TOKENS":
		case "MAX_OUTPUT_TOKENS":
		case "LENGTH": return { kind: "max-tokens" };
		case "MODEL_CONTEXT_WINDOW_EXCEEDED":
		case "CONTEXT_WINDOW_EXCEEDED": return {
			kind: "error",
			failure: {
				message: "Kiro stopped the turn because the model context window was exceeded",
				code: CONTEXT_WINDOW_EXCEEDED_CODE
			}
		};
		case "CONTENT_FILTERED":
		case "REFUSAL": return {
			kind: "error",
			failure: {
				message: `Kiro stopped the turn with a content refusal${refusalDetail(details)}`,
				code: "CONTENT_FILTERED"
			}
		};
		case "PAUSE_TURN": return {
			kind: "error",
			failure: {
				message: "Kiro paused the turn before it completed",
				code: "PAUSE_TURN"
			}
		};
		default: return {
			kind: "error",
			failure: {
				message: `Kiro stopped the turn with an unrecognized reason "${reason}"`,
				code: "UNKNOWN_STOP_REASON"
			}
		};
	}
}
/**
* Translate decoded frames into harness chunks.
* @param frames - decoded event-stream frames in arrival order.
* @returns deltas as they arrive, every `block-end`, exact terminal `usage`
*   when supplied by Kiro, then one `finish`.
* @throws `LlmError` for an in-band service exception frame or a malformed payload.
*/
async function* translate(frames, contextWindow) {
	const router = new TextRouter();
	const guard = new LegacyMarkerGuard();
	const order = [];
	const toolBlocks = /* @__PURE__ */ new Map();
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	let usage;
	let stopReason;
	let stopDetails;
	let contextPercentage;
	let outputCharacters = 0;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	function* emitText(text$3) {
		outputCharacters += text$3.length;
		if (textBlock === void 0) {
			textBlock = open("text");
			yield {
				type: "block-start",
				index: textBlock.index,
				blockType: "text"
			};
		}
		textBlock.text += text$3;
		yield {
			type: "text-delta",
			index: textBlock.index,
			text: text$3
		};
	}
	function* emitReasoning(text$3) {
		outputCharacters += text$3.length;
		if (reasoningBlock === void 0) {
			reasoningBlock = open("reasoning");
			yield {
				type: "block-start",
				index: reasoningBlock.index,
				blockType: "reasoning"
			};
		}
		reasoningBlock.text += text$3;
		yield {
			type: "reasoning-delta",
			index: reasoningBlock.index,
			text: text$3
		};
	}
	function* route(runs) {
		for (const run of runs) {
			if (run.channel === "reasoning") {
				yield* emitReasoning(run.text);
				continue;
			}
			const visible = guard.push(run.text);
			if (visible.length > 0) yield* emitText(visible);
		}
	}
	for await (const frame of frames) {
		const exception = frame.headers[":exception-type"];
		if (exception !== void 0) throw new LlmError(`Kiro service exception ${exception}: ${new TextDecoder().decode(frame.payload).slice(0, 300)}`, exception);
		switch (frame.headers[":event-type"]) {
			case "assistantResponseEvent": {
				const event = parsePayload(frame);
				if (typeof event.content === "string" && event.content.length > 0) yield* route(router.push(event.content));
				break;
			}
			case "reasoningContentEvent": {
				const event = parsePayload(frame);
				if (typeof event.text === "string" && event.text.length > 0) yield* emitReasoning(event.text);
				break;
			}
			case "toolUseEvent": {
				const event = parsePayload(frame);
				let block = toolBlocks.get(event.toolUseId);
				if (block === void 0) {
					block = open("tool-call");
					block.callId = event.toolUseId;
					toolBlocks.set(event.toolUseId, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (event.name !== void 0) block.name = event.name;
				const fragment = event.input ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(event.toolUseId),
					...block.name === void 0 ? {} : { name: block.name },
					argumentsDelta: fragment
				};
				break;
			}
			case "metadataEvent": {
				const event = parsePayload(frame);
				usage = tokenUsageOf(event.tokenUsage) ?? usage;
				const percentage$1 = event.tokenUsage?.contextUsagePercentage;
				if (typeof percentage$1 === "number" && Number.isFinite(percentage$1)) contextPercentage = percentage$1;
				if (typeof event.stopReason === "string" && event.stopReason.length > 0) {
					stopReason = event.stopReason;
					stopDetails = event.stopDetails;
				}
				break;
			}
			case "contextUsageEvent": {
				const event = parsePayload(frame);
				if (typeof event.contextUsagePercentage === "number" && Number.isFinite(event.contextUsagePercentage)) contextPercentage = event.contextUsagePercentage;
				break;
			}
			default: break;
		}
	}
	yield* route(router.flush());
	const withheld = guard.flush();
	if (withheld.length > 0) yield* emitText(withheld);
	for (const block of order) yield {
		type: "block-end",
		index: block.index,
		block: closeBlock(block)
	};
	const reason = finishReasonOf(stopReason, stopDetails, toolBlocks.size > 0) ?? (toolBlocks.size > 0 ? { kind: "tool-calls" } : order.length > 0 ? { kind: "stop" } : {
		kind: "error",
		failure: {
			message: "Kiro returned a completed response with no content",
			code: EMPTY_RESPONSE_CODE
		}
	});
	const settled = order.length === 0 && (reason.kind === "stop" || reason.kind === "tool-calls") ? {
		kind: "error",
		failure: {
			message: "Kiro returned a completed response with no content",
			code: EMPTY_RESPONSE_CODE
		}
	} : reason;
	const priced = usage ?? contextUsageTokens(contextPercentage, contextWindow, outputCharacters);
	if (priced !== void 0) yield {
		type: "usage",
		usage: priced
	};
	yield {
		type: "finish",
		reason: settled
	};
}

//#endregion
//#region lib/types/profile.js
/** Validation and region extraction for Kiro CodeWhisperer profile ARNs. */
const PROFILE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-[0-9]+):[0-9]{12}:profile\/[A-Za-z0-9+=,.@_-]+$/u;
/** Validate a Kiro profile ARN before it reaches a request URL or body. */
function assertKiroProfileArn(value) {
	const profileArn = value.trim();
	if (!PROFILE_ARN.test(profileArn)) throw new Error("dsh-kiro: invalid CodeWhisperer profile ARN");
	return profileArn;
}
/** Return the AWS region embedded in a validated profile ARN. */
function profileRegion(value) {
	const profileArn = assertKiroProfileArn(value);
	const match = PROFILE_ARN.exec(profileArn);
	if (match?.[1] === void 0) throw new Error("dsh-kiro: profile ARN contains no region");
	return match[1];
}

//#endregion
//#region lib/types/adapter.js
/**
* `KiroAdapter`: the Kiro `generateAssistantResponse` operation behind the
* harness LLM seam. The adapter is transport-only — connection facts arrive
* through a thunk resolved once per stream call and the bearer token through a
* per-request resolver — so the registering plugin owns validation, layering,
* and credential policy.
*
* @module dsh-kiro/adapter
*/
var __addDisposableResource = void 0 && (void 0).__addDisposableResource || function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = void 0 && (void 0).__disposeResources || (function(SuppressedError$1) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError$1(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Default maximum idle interval while an outstanding provider read is pending. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request/response context capacity for a Kiro model. */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** Timeout code distinguishing watchdog expiry from caller cancellation. */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** User agent Kiro's own IDE sends; the service gates model access on it. */
const KIRO_USER_AGENT$2 = "aws-sdk-js/3.738.0 KiroIDE";
const CODEWHISPERER_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const OFF = ReasoningEffortId("off");
/** Legacy efforts for configured models that predate live schema discovery. */
const LEGACY_REASONING_EFFORTS = [
	"off",
	"low",
	"medium",
	"high"
];
/** The only effort a thinking-disabled deployment publishes. */
const OFF_ONLY_REASONING_EFFORTS = [{
	id: OFF,
	name: "Off"
}];
/**
* Kiro's `ValidationException` reason for a request whose serialized content
* exceeded the service bound. Kiro's own client maps exactly this reason to a
* context-window-exceeded failure, which is what makes DSH compaction run.
*/
const CONTEXT_OVERFLOW_REASON = "CONTENT_LENGTH_EXCEEDS_THRESHOLD";
/**
* Message wording Kiro's own client treats as context overflow. Kept byte-for-byte
* with `src/utils/context-overflow.ts` in the installed Kiro agent so a provider
* message that reaches recovery there also reaches it here.
*/
const CONTEXT_OVERFLOW_MESSAGES = ["input is too long", "prompt is too long"];
/**
* Reasons that mean an allowance is spent rather than momentarily throttled,
* taken from the service model's own enums rather than guessed:
* `ThrottlingExceptionReason` is CREDIT_CONSUMPTION_RATE_EXCEEDED,
* DAILY_REQUEST_COUNT, INSUFFICIENT_MODEL_CAPACITY, MONTHLY_REQUEST_COUNT,
* SERVICE_REQUEST_RATE_EXCEEDED, USER_REQUEST_RATE_EXCEEDED; and
* `ServiceQuotaExceededExceptionReason` is CONVERSATION_LIMIT_EXCEEDED,
* MONTHLY_REQUEST_COUNT, OVERAGE_REQUEST_LIMIT_EXCEEDED.
*
* Only the counted allowances belong here. The three rate reasons and
* INSUFFICIENT_MODEL_CAPACITY name something transient, so they stay a rate
* limit and keep their backoff — including CREDIT_CONSUMPTION_RATE_EXCEEDED,
* which is a burn rate in the throttling vocabulary, not an empty balance.
*/
const QUOTA_REASONS = [
	"MONTHLY_REQUEST_COUNT",
	"DAILY_REQUEST_COUNT",
	"OVERAGE_REQUEST_LIMIT_EXCEEDED"
];
/**
* A conversation the service will not extend further. The harness's only lever
* is to make the conversation smaller, which is what the overflow code asks for,
* so it is reported as overflow rather than as an opaque quota failure. Inferred
* from the enum; not yet observed live.
*/
const CONVERSATION_LIMIT_REASON = "CONVERSATION_LIMIT_EXCEEDED";
function effortName(effort) {
	if (effort === "xhigh") return "xHigh";
	return effort.length === 0 ? effort : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;
}
function effortInfo(efforts) {
	return efforts.map((effort) => ({
		id: ReasoningEffortId(effort),
		name: effortName(effort)
	}));
}
/** Select the upstream surface Kiro accepts for one request region. */
function kiroRequestEndpoint(_token, region) {
	return `${kiroApiEndpoint(region).url}/generateAssistantResponse`;
}
/** Add the token discriminator required by API-key and external-IdP auth. */
function kiroTokenTypeHeaders(token) {
	if (token.authMethod === "api_key") return { TokenType: "API_KEY" };
	if (token.authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
/**
* Request-image budget for a Kiro turn.
*
* Kiro's catalog states token limits and cache checkpoints but says nothing
* about image bounds, so these follow the service its models run behind:
* 8000x8000 is the documented per-image dimension ceiling, and 3.75 MB is the
* encoded-byte ceiling. Both are applied before base64 expansion, which is what
* the wire actually carries.
*/
const IMAGE_MAX_PIXELS = 8e3 * 8e3;
const IMAGE_MAX_BYTES = 375e4;
/** Media types Kiro's `ImageFormat` enum accepts, mapped to its own spelling. */
const IMAGE_FORMATS = new Map([
	["image/png", "png"],
	["image/jpeg", "jpeg"],
	["image/gif", "gif"],
	["image/webp", "webp"]
]);
/**
* Collect every image reference in one request, including images nested in tool
* results, so each is read exactly once however often it is repeated.
* @param content - blocks from one message.
* @param refs - accumulator keyed by attachment id.
*/
function collectImageRefs(content, refs) {
	for (const block of content) if (block.type === "image") refs.set(block.attachment.attachmentId, block.attachment);
	else if (block.type === "tool-result") collectImageRefs(block.content, refs);
}
/**
* Read and re-encode every request image into Kiro's wire shape.
*
* Returned as a map so serialization stays synchronous and the bytes for one
* attachment are fetched once no matter how many turns repeat it.
* @param options - the harness request.
* @param store - the attachment store, when the profile mounts one.
* @param signal - request cancellation.
* @returns wire image blocks by attachment id; empty when the request has none.
* @throws `LlmError('UNSUPPORTED_CONTENT')` for a media type Kiro cannot accept.
*/
async function prepareImages(options, store, signal) {
	const refs = /* @__PURE__ */ new Map();
	for (const message of options.messages) collectImageRefs(message.content, refs);
	const prepared = /* @__PURE__ */ new Map();
	if (refs.size === 0) return prepared;
	if (store === void 0) throw new LlmError("Kiro cannot send images because this profile mounts no attachment service.", "UNSUPPORTED_CONTENT");
	for (const [id, ref] of refs) {
		const version = await store.readImageRequest(ref, {
			maxPixels: IMAGE_MAX_PIXELS,
			maxBytes: IMAGE_MAX_BYTES
		}, signal);
		const format = IMAGE_FORMATS.get(version.mediaType);
		if (format === void 0) throw new LlmError(`Kiro accepts png, jpeg, gif and webp images; ${ref.mediaType} is not one of them.`, "UNSUPPORTED_CONTENT");
		prepared.set(id, {
			format,
			source: { bytes: Buffer.from(version.data).toString("base64") }
		});
	}
	return prepared;
}
/** Describe one catalog entry for selector consumers. */
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.inputModalities ?? ["text"]
	};
}
/**
* Recognize a Kiro HTTP 400 body that reports a context-window overflow rather
* than an ordinary validation failure. Deliberately narrow: only Kiro's own
* validation reason, the two message phrases its client matches, and the
* harness's provider-neutral wording classifier. Every other 400 stays a plain
* invalid request, because mapping all of them would make DSH compact and
* retry turns that a smaller context cannot fix.
* @param body - the response body text, when available.
* @returns true when the body identifies a context-overflow rejection.
*/
function isKiroContextOverflow(body) {
	if (body === void 0 || body.length === 0) return false;
	if (body.includes(CONTEXT_OVERFLOW_REASON) || body.includes(CONVERSATION_LIMIT_REASON)) return true;
	const normalized = body.toLowerCase();
	return CONTEXT_OVERFLOW_MESSAGES.some((phrase) => normalized.includes(phrase)) || isContextWindowExceededError(body);
}
/**
* Recognize a body that reports an exhausted account allowance rather than a
* transient throttle. Kiro's own vocabulary is checked first, then the harness's
* provider-neutral wording classifier.
* @param body - the response body text, when available.
* @returns true when the account's plan or credits are spent.
*/
function isKiroQuotaExhausted(body) {
	if (body === void 0 || body.length === 0) return false;
	if (body.includes(CONVERSATION_LIMIT_REASON)) return false;
	return QUOTA_REASONS.some((reason) => body.includes(reason)) || isQuotaExceededError(body);
}
/**
* Map a Kiro HTTP status and error body to a stable harness code.
* @param status - status of a non-2xx response.
* @param body - the response body text, when available.
* @returns the normalized harness error code.
*/
function httpErrorCode(status, body) {
	if (status === 401) return "AUTH";
	if (status === 403) {
		if (body !== void 0 && body.includes("bearer token")) return "AUTH";
		return isKiroQuotaExhausted(body) ? QUOTA_EXCEEDED_CODE : "FORBIDDEN";
	}
	if (isKiroContextOverflow(body)) return CONTEXT_WINDOW_EXCEEDED_CODE;
	if (status === 402) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return isKiroQuotaExhausted(body) ? QUOTA_EXCEEDED_CODE : "RATE_LIMIT";
	if (status === 400) {
		if (body !== void 0 && body.includes("INVALID_MODEL_ID")) return "INVALID_MODEL";
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/**
* Derive the provider conversation id for one DSH session.
*
* Kiro correlates caching and diagnostics by `conversationId`, so a new random
* id per turn presents one durable session as a stream of unrelated
* conversations. The id is a keyed digest of the DSH session id rather than the
* id itself: stable for the session, separate across sessions, and carrying no
* recoverable DSH identifier upstream.
* @param sessionId - the DSH session identity stamped on the request, if any.
* @returns a UUID-shaped conversation id, random when no session is named.
*/
function conversationIdFor(sessionId) {
	if (sessionId === void 0 || sessionId.length === 0) return randomUUID();
	const digest = createHash("sha256").update(`dsh-kiro:conversation:${sessionId}`).digest();
	const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
	bytes[6] = (bytes[6] ?? 0) & 15 | 128;
	bytes[8] = (bytes[8] ?? 0) & 63 | 128;
	const hex = Buffer.from(bytes).toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32)
	].join("-");
}
/**
* The Kiro adapter. One instance serves the whole route: the harness model
* name is the wire `modelId`, so adding a Kiro model is configuration rather
* than registration.
*/
var KiroAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Kiro"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	async listModels(provider) {
		const connection = this.config.options();
		const discovered = this.config.discoverModels === void 0 ? connection.models : await this.config.discoverModels(connection, AbortSignal.timeout(1e4));
		return (this.config.selectModels === void 0 ? discovered : await this.config.selectModels(discovered)).map((model) => modelInfo(provider, model));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = (this.config.currentModels?.(connection) ?? connection.models).find((entry) => entry.id === model);
		const thinking = connection.defaults.thinking !== "disabled" && (configured?.thinking ?? true);
		const efforts = configured?.reasoningEfforts ?? (thinking ? LEGACY_REASONING_EFFORTS : ["off"]);
		const requestedDefault = connection.defaults.reasoningEffort;
		const defaultEffort = requestedDefault !== void 0 && efforts.includes(requestedDefault) ? requestedDefault : configured?.defaultReasoningEffort !== void 0 && efforts.includes(configured.defaultReasoningEffort) ? configured.defaultReasoningEffort : efforts.includes("high") ? "high" : efforts[0] ?? "off";
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
			...configured?.maxTokens === void 0 ? {} : { defaultMaxTokens: configured.maxTokens },
			reasoning: thinking ? {
				efforts: effortInfo(efforts),
				defaultEffort: ReasoningEffortId(defaultEffort)
			} : {
				efforts: OFF_ONLY_REASONING_EFFORTS,
				defaultEffort: OFF
			}
		});
	}
	async *stream(options) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const connection = this.config.options();
			const consumer = new AbortController();
			const watchdog = __addDisposableResource(env_1, idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
			const iterator = this.request(options, watchdog.signal, connection, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("Kiro request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError("Kiro API stream failed", "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("Kiro stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
	async *request(options, signal, connection, onActivity) {
		const token = await this.config.resolveToken(connection, signal);
		const profileArn = connection.profileArn ?? token.profileArn;
		const url = kiroRequestEndpoint(token, profileArn === void 0 ? connection.region ?? token.region : profileRegion(profileArn));
		const selected = (this.config.currentModels?.(connection) ?? connection.models).find((model) => model.id === options.model);
		const nativeEffort = selected?.effortSchemaPath === void 0 || selected.reasoningEfforts === void 0 ? void 0 : {
			schemaPath: selected.effortSchemaPath,
			levels: selected.reasoningEfforts,
			...selected.defaultReasoningEffort === void 0 ? {} : { defaultLevel: selected.defaultReasoningEffort }
		};
		const requestHasImages = options.messages.some((message) => contentHasImage(message.content));
		if (requestHasImages && selected?.inputModalities?.includes("image") !== true) throw new LlmError(`Kiro model "${options.model}" does not accept images.`, "UNSUPPORTED_CONTENT");
		const images = requestHasImages ? await prepareImages(options, this.config.resolveAttachments?.(), signal) : void 0;
		const body = JSON.stringify(serializeRequest(options, connection.defaults, conversationIdFor(options.sessionId), profileArn, nativeEffort, selected?.maxTokensBounds === void 0 ? void 0 : { maxTokensBounds: selected.maxTokensBounds }, images));
		const response = await post({
			url,
			headers: {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
				authorization: `Bearer ${token.accessToken}`,
				"x-amz-target": CODEWHISPERER_TARGET,
				...kiroTokenTypeHeaders(token),
				"x-amzn-kiro-agent-mode": "vibe",
				"user-agent": KIRO_USER_AGENT$2,
				"x-amz-user-agent": `${KIRO_USER_AGENT$2} ${userAgent()}`
			},
			body,
			signal,
			...connection.proxyUrl === void 0 ? {} : { proxyUrl: connection.proxyUrl }
		});
		if (response.status !== 200) {
			const chunks = [];
			for await (const chunk of response.body) chunks.push(chunk);
			const text$3 = Buffer.concat(chunks).toString("utf8");
			let message = `Kiro API error (HTTP ${response.status})`;
			try {
				const parsed = JSON.parse(text$3);
				if (parsed.message !== void 0) message = parsed.message;
			} catch {}
			const id = response.headers["x-amzn-requestid"];
			throw new LlmError(message, httpErrorCode(response.status, text$3), {
				status: response.status,
				...typeof id === "string" && id.length > 0 ? { requestId: ProviderRequestId(id) } : {}
			});
		}
		yield* translate(decodeFrames(response.body, onActivity), selected?.contextWindow ?? connection.defaultContextWindow);
	}
};

//#endregion
//#region lib/types/external-idp.js
const MICROSOFT_TOKEN_HOSTS = new Set([
	"login.microsoftonline.com",
	"login.microsoft.com",
	"login.windows.net"
]);
function record$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text$2(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function scopes(value) {
	if (Array.isArray(value)) {
		const result = value.map(text$2).filter((item) => item !== void 0).join(" ");
		return result.length > 0 ? result : void 0;
	}
	return text$2(value);
}
/** Restrict imported token endpoints to Microsoft's real login hosts. */
function assertMicrosoftTokenEndpoint(value) {
	let url;
	try {
		url = new URL(value.trim());
	} catch (error) {
		throw new Error("dsh-kiro: external IdP token endpoint is not a valid URL", { cause: error });
	}
	if (url.protocol !== "https:" || !MICROSOFT_TOKEN_HOSTS.has(url.hostname.toLowerCase())) throw new Error("dsh-kiro: external IdP token endpoint must use an approved Microsoft login host");
	return url.toString();
}
function jwtExpiry(accessToken) {
	try {
		const part = accessToken.split(".")[1];
		if (part === void 0) return void 0;
		const expiry = record$4(JSON.parse(Buffer.from(part, "base64url").toString("utf8")))?.exp;
		return typeof expiry === "number" && Number.isFinite(expiry) ? (/* @__PURE__ */ new Date(expiry * 1e3)).toISOString() : void 0;
	} catch {
		return;
	}
}
/** Parse snake_case or camelCase CLIProxyAPI Kiro auth JSON. */
function normalizeExternalIdpCredentials(raw) {
	let parsed = raw;
	if (typeof raw === "string") try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error("dsh-kiro: external IdP credential JSON is invalid", { cause: error });
	}
	const value = record$4(parsed);
	if (value === void 0) throw new Error("dsh-kiro: external IdP credential JSON is required");
	const method = text$2(value.authMethod ?? value.auth_method);
	if (method !== void 0 && method !== "external_idp") throw new Error("dsh-kiro: imported credential is not external_idp auth");
	const accessToken = text$2(value.accessToken ?? value.access_token);
	const refreshToken = text$2(value.refreshToken ?? value.refresh_token);
	const clientId = text$2(value.clientId ?? value.client_id);
	const tokenEndpoint = text$2(value.tokenEndpoint ?? value.token_endpoint);
	const profileArn = text$2(value.profileArn ?? value.profile_arn);
	const scope = scopes(value.scope ?? value.scopes);
	if (accessToken === void 0) throw new Error("dsh-kiro: external IdP access_token is required");
	if (refreshToken === void 0) throw new Error("dsh-kiro: external IdP refresh_token is required");
	if (clientId === void 0) throw new Error("dsh-kiro: external IdP client_id is required");
	if (tokenEndpoint === void 0) throw new Error("dsh-kiro: external IdP token_endpoint is required");
	if (profileArn === void 0) throw new Error("dsh-kiro: external IdP profile_arn is required");
	if (scope === void 0) throw new Error("dsh-kiro: external IdP scopes are required");
	const explicitExpiry = text$2(value.expiresAt ?? value.expires_at ?? value.expired);
	const expiresIn = Number(value.expiresIn ?? value.expires_in);
	return {
		accessToken,
		refreshToken,
		expiresAt: explicitExpiry !== void 0 && Number.isFinite(Date.parse(explicitExpiry)) ? new Date(explicitExpiry).toISOString() : Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1e3).toISOString() : jwtExpiry(accessToken) ?? new Date(Date.now() + 36e5).toISOString(),
		region: assertKiroRegion(text$2(value.region) ?? "us-east-1"),
		profileArn: assertKiroProfileArn(profileArn),
		clientId,
		tokenEndpoint: assertMicrosoftTokenEndpoint(tokenEndpoint),
		scope,
		authMethod: "external_idp"
	};
}

//#endregion
//#region lib/types/auth.js
const SSO_CACHE_DIR = [
	".aws",
	"sso",
	"cache"
];
const TOKEN_FILE$1 = "kiro-auth-token.json";
const SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const NON_EXPIRING = Number.MAX_SAFE_INTEGER;
const DEFAULT_REGION = "us-east-1";
/**
* Methods whose refresh needs nothing but the refresh token, because Kiro's own
* desktop auth service issues them. Kiro refreshes its `social` tokens exactly
* this way, with no client registration involved.
*/
const KIRO_SERVICE_METHODS = new Set([
	"imported",
	"google",
	"github",
	"social"
]);
/** Directory holding Kiro IDE/CLI's shared SSO cache. */
function kiroCredentialDirectory() {
	return join(homedir(), ...SSO_CACHE_DIR);
}
function record$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function numeric$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* Classify one credential file's authentication method.
*
* Two vocabularies land here: this plugin's own, and Kiro IDE/CLI's, which is
* what a fresh install reads from the shared SSO cache. Kiro writes `social`,
* `IdC`, and `external_idp` — the same three its own refresher switches on — so
* those are recognized rather than guessed at, because the guess decides both
* the refresh endpoint and the upstream request surface.
* @param value - the file's recorded method, if any.
* @param source - the whole credential record, for provenance fallbacks.
* @returns the normalized method.
*/
function inferAuthMethod(value, source) {
	if (value === "builder-id" || value === "idc" || value === "google" || value === "github" || value === "social" || value === "imported" || value === "api_key" || value === "external_idp") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "idc") return "idc";
		if (normalized === "social") return "social";
		if (normalized === "builderid" || normalized === "builder_id") return "builder-id";
		if (normalized === "apikey" || normalized === "api-key") return "api_key";
		if (normalized === "externalidp" || normalized === "external-idp") return "external_idp";
	}
	if (source.tokenEndpoint !== void 0 || source.token_endpoint !== void 0) return "external_idp";
	if (source.tokenType === "API_KEY" || source.token_type === "API_KEY") return "api_key";
	const configuredStartUrl = text$1(source.startUrl ?? source.start_url);
	if (source.clientIdHash !== void 0 || source.client_id_hash !== void 0) return configuredStartUrl === void 0 || configuredStartUrl === "https://view.awsapps.com/start" ? "builder-id" : "idc";
	if (configuredStartUrl !== void 0 && configuredStartUrl !== "https://view.awsapps.com/start") return "idc";
	return "builder-id";
}
/**
* Normalize any credential record's recorded method into the vocabulary this
* adapter acts on. Exported so surfaces report the method that actually decides
* refresh and endpoint selection, instead of the raw string on disk.
* @param value - the file's recorded method, if any.
* @param source - the whole credential record, for provenance fallbacks.
* @returns the normalized method.
*/
function kiroAuthMethod(value, source = {}) {
	return inferAuthMethod(value, source);
}
function normalizeTokenFile(value) {
	const source = record$3(value);
	if (source === void 0) throw new LlmError("Kiro token file is not a JSON object", "INVALID_CREDENTIAL");
	const accessToken = text$1(source.accessToken ?? source.access_token);
	const refreshToken = text$1(source.refreshToken ?? source.refresh_token);
	const expiresAt = text$1(source.expiresAt ?? source.expires_at ?? source.expired);
	const clientIdHash = text$1(source.clientIdHash ?? source.client_id_hash);
	const clientId = text$1(source.clientId ?? source.client_id);
	const tokenEndpoint = text$1(source.tokenEndpoint ?? source.token_endpoint);
	const scope = Array.isArray(source.scopes) ? source.scopes.map(text$1).filter((item) => item !== void 0).join(" ") : text$1(source.scope ?? source.scopes);
	const region = text$1(source.region);
	const profileArn = text$1(source.profileArn ?? source.profile_arn);
	const startUrl$1 = text$1(source.startUrl ?? source.start_url);
	return {
		...accessToken === void 0 ? {} : { accessToken },
		...refreshToken === void 0 ? {} : { refreshToken },
		...expiresAt === void 0 ? {} : { expiresAt },
		...clientIdHash === void 0 ? {} : { clientIdHash },
		...clientId === void 0 ? {} : { clientId },
		...tokenEndpoint === void 0 ? {} : { tokenEndpoint },
		...scope === void 0 || scope.length === 0 ? {} : { scope },
		...region === void 0 ? {} : { region },
		...profileArn === void 0 ? {} : { profileArn },
		authMethod: inferAuthMethod(source.authMethod ?? source.auth_method, source),
		...startUrl$1 === void 0 ? {} : { startUrl: startUrl$1 },
		raw: source
	};
}
async function readJsonFile(path, what) {
	let value;
	try {
		value = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") throw new LlmError(`Kiro ${what} not found at ${path}`, "MISSING_CREDENTIAL", { cause: error });
		throw new LlmError(`Kiro ${what} at ${path} could not be read`, "INVALID_CREDENTIAL", { cause: error });
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new LlmError(`Kiro ${what} at ${path} is not valid JSON`, "INVALID_CREDENTIAL", { cause: error });
	}
}
const cached = /* @__PURE__ */ new Map();
function clearTokenCache() {
	cached.clear();
}
function refreshDetail(body, status) {
	const value = record$3(body);
	return text$1(value?.error_description ?? value?.errorDescription ?? value?.message ?? value?.error) ?? `HTTP ${status}`;
}
function parseRefresh(body, fallbackRefreshToken) {
	const value = record$3(body);
	const accessToken = text$1(value?.accessToken ?? value?.access_token);
	if (accessToken === void 0) throw new LlmError("Kiro token refresh returned no access token", "AUTH");
	const lifetime = Math.max(1, numeric$1(value?.expiresIn ?? value?.expires_in) ?? 3600);
	const rawProfile = text$1(value?.profileArn ?? value?.profile_arn);
	return {
		accessToken,
		refreshToken: text$1(value?.refreshToken ?? value?.refresh_token) ?? fallbackRefreshToken,
		expiresAt: Date.now() + lifetime * 1e3,
		...rawProfile === void 0 ? {} : { profileArn: assertKiroProfileArn(rawProfile) }
	};
}
async function registration(directory, hash) {
	const value = record$3(await readJsonFile(join(directory, `${hash}.json`), "device registration"));
	const clientId = text$1(value?.clientId ?? value?.client_id);
	const clientSecret = text$1(value?.clientSecret ?? value?.client_secret);
	if (clientId === void 0 || clientSecret === void 0) throw new LlmError("Kiro device registration is missing its client id or secret", "INVALID_CREDENTIAL");
	return {
		clientId,
		clientSecret
	};
}
async function refresh(token, directory, region, options) {
	const refreshToken = token.refreshToken;
	if (refreshToken === void 0) throw new LlmError("Kiro credential has expired and carries no refresh token", "INVALID_CREDENTIAL");
	let response;
	if (token.authMethod === "external_idp") {
		if (token.clientId === void 0 || token.tokenEndpoint === void 0 || token.scope === void 0) throw new LlmError("Kiro external IdP credential is missing client, endpoint, or scopes", "INVALID_CREDENTIAL");
		if (options.fetchForm === void 0) throw new LlmError("Kiro external IdP refresh transport is unavailable", "INVALID_CREDENTIAL");
		response = await options.fetchForm(assertMicrosoftTokenEndpoint(token.tokenEndpoint), new URLSearchParams({
			grant_type: "refresh_token",
			client_id: token.clientId,
			refresh_token: refreshToken,
			scope: token.scope
		}));
	} else if (token.clientIdHash !== void 0) {
		const client = await registration(directory, token.clientIdHash);
		response = await options.fetchJson(`https://oidc.${region}.amazonaws.com/token`, {
			refreshToken,
			clientId: client.clientId,
			clientSecret: client.clientSecret,
			grantType: "refresh_token"
		});
	} else if (KIRO_SERVICE_METHODS.has(token.authMethod)) response = await options.fetchJson(SOCIAL_REFRESH_URL, { refreshToken });
	else throw new LlmError(`Kiro ${token.authMethod} credential cannot be refreshed without its client registration; sign in through the Kiro settings page to store a refreshable credential`, "INVALID_CREDENTIAL");
	if (response.status !== 200) throw new LlmError(`Kiro token refresh failed: ${refreshDetail(response.body, response.status)}`, "AUTH", { status: response.status });
	const parsed = parseRefresh(response.body, refreshToken);
	const existingProfile = token.profileArn === void 0 ? void 0 : assertKiroProfileArn(token.profileArn);
	const refreshedProfile = parsed.profileArn ?? existingProfile;
	return {
		refreshToken: parsed.refreshToken,
		token: {
			accessToken: parsed.accessToken,
			region,
			expiresAt: parsed.expiresAt,
			authMethod: token.authMethod,
			...refreshedProfile === void 0 ? {} : { profileArn: refreshedProfile }
		}
	};
}
async function atomicTokenFile(directory, value) {
	const path = join(directory, TOKEN_FILE$1);
	const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, path);
}
async function persist(directory, source, token, refreshToken) {
	await atomicTokenFile(directory, {
		...source.raw,
		accessToken: token.accessToken,
		...refreshToken === void 0 ? {} : { refreshToken },
		expiresAt: new Date(token.expiresAt).toISOString(),
		region: token.region,
		authMethod: token.authMethod,
		...token.profileArn === void 0 ? {} : { profileArn: token.profileArn }
	});
}
async function withProfile(result, source, directory, options, refreshToken) {
	if (result.profileArn !== void 0 || result.authMethod === "api_key" || options.resolveProfileArn === void 0) return result;
	let profileArn;
	try {
		profileArn = await options.resolveProfileArn(result.accessToken, result.region, result.authMethod);
	} catch {
		return result;
	}
	if (profileArn === void 0) return result;
	const enriched = {
		...result,
		profileArn: assertKiroProfileArn(profileArn)
	};
	cached.set(directory, enriched);
	if (options.persistRefresh === true) await persist(directory, source, enriched, refreshToken ?? source.refreshToken);
	return enriched;
}
/** Resolve a currently usable token from one credential directory. */
async function resolveToken(options) {
	const now = Date.now();
	const directory = options.cacheDir ?? kiroCredentialDirectory();
	const cachedToken = cached.get(directory);
	if (cachedToken !== void 0 && now < cachedToken.expiresAt - options.expiryBufferMs) return cachedToken;
	const source = normalizeTokenFile(await readJsonFile(join(directory, TOKEN_FILE$1), "token file"));
	let region;
	try {
		region = assertKiroRegion(source.region ?? DEFAULT_REGION);
	} catch (error) {
		throw new LlmError("Kiro token file contains an invalid AWS region", "INVALID_CREDENTIAL", { cause: error });
	}
	let profileArn;
	try {
		profileArn = source.profileArn === void 0 ? void 0 : assertKiroProfileArn(source.profileArn);
	} catch (error) {
		throw new LlmError("Kiro token file contains an invalid profile ARN", "INVALID_CREDENTIAL", { cause: error });
	}
	const fileExpiry = source.authMethod === "api_key" ? NON_EXPIRING : source.expiresAt === void 0 ? 0 : Date.parse(source.expiresAt);
	if (source.accessToken !== void 0 && Number.isFinite(fileExpiry) && now < fileExpiry - options.expiryBufferMs) {
		const result$1 = await withProfile({
			accessToken: source.accessToken,
			region,
			expiresAt: fileExpiry,
			authMethod: source.authMethod,
			...profileArn === void 0 ? {} : { profileArn }
		}, source, directory, options);
		cached.set(directory, result$1);
		return result$1;
	}
	const refreshed = await refresh(source, directory, region, options);
	let result = refreshed.token;
	if (options.persistRefresh === true) await persist(directory, source, result, refreshed.refreshToken);
	result = await withProfile(result, source, directory, options, refreshed.refreshToken);
	cached.set(directory, result);
	return result;
}
/** Resolve the first present source, preferring DSH-managed credentials over Kiro's cache. */
async function resolveTokenFromDirectories(directories, options) {
	const unique = [...new Set(directories)];
	const writable = new Set(options.writableDirectories ?? []);
	let lastMissing;
	for (const cacheDir of unique) try {
		return await resolveToken({
			...options,
			cacheDir,
			persistRefresh: writable.has(cacheDir)
		});
	} catch (error) {
		if (error.code !== "MISSING_CREDENTIAL") throw error;
		lastMissing = error;
	}
	if (lastMissing !== void 0) throw lastMissing;
	throw new LlmError("No Kiro credential sources were configured", "MISSING_CREDENTIAL");
}

//#endregion
//#region lib/types/discovery.js
const DEFAULT_CACHE_TTL_MS$1 = 300 * 1e3;
const KIRO_USER_AGENT$1 = "aws-sdk-js/3.738.0 KiroIDE";
/** Models requested per page; the service caps a page at its own maximum. */
const PAGE_SIZE = 50;
/**
* Pages followed before giving up on a continuation token. `ListAvailableModels`
* declares `nextToken` on both its request and its response, so a truncated
* catalog is a real possibility; a bounded walk keeps a misbehaving or looping
* token from turning discovery into an unbounded request sequence.
*/
const MAX_PAGES = 10;
/**
* Modalities in the order selectors should show them. Fixed rather than taken
* from the wire so one account's ordering cannot become a UI difference.
*/
const MODALITY_ORDER = ["text", "image"];
/**
* Read the input modalities a catalog entry declares.
*
* The service states this per model as `supportedInputTypes: ["TEXT","IMAGE"]`,
* so the capability is read rather than inferred from the model id: on this
* account 17 of 19 models accept images while `glm-5` and `minimax-m2.5` accept
* only text, and an id-based guess would send images to a model that refuses
* them. An unreadable value yields absence, which leaves the configured default
* in force instead of silently narrowing the model to text.
* @param value - the raw `supportedInputTypes` member.
* @returns declared modalities in display order, or undefined when unreadable.
*/
function parseInputModalities(value) {
	if (!Array.isArray(value)) return void 0;
	const declared = new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim().toLowerCase()));
	const modalities = MODALITY_ORDER.filter((modality) => declared.has(modality));
	return modalities.length === 0 ? void 0 : [...modalities];
}
function record$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function tokenTypeHeaders$1(authMethod) {
	if (authMethod === "api_key") return { TokenType: "API_KEY" };
	if (authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
function authHeaders(token) {
	return {
		authorization: `Bearer ${token.accessToken}`,
		"user-agent": KIRO_USER_AGENT$1,
		"x-amz-user-agent": KIRO_USER_AGENT$1,
		"x-amzn-codewhisperer-optout": "true",
		...tokenTypeHeaders$1(token.authMethod)
	};
}
/** Resolve the best CodeWhisperer profile ARN for one OAuth credential. */
async function discoverKiroProfileArn(connection, token, signal, request$2 = postJsonWithHeaders) {
	if (token.authMethod === "api_key") return void 0;
	const candidates = [...new Set([
		"us-east-1",
		"eu-central-1",
		connection.region,
		token.region
	].filter((candidate) => candidate !== void 0))];
	const tried = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		const endpoint = kiroApiEndpoint(candidate).url;
		if (tried.has(endpoint)) continue;
		tried.add(endpoint);
		const attempts = [{
			url: `${endpoint}/ListAvailableProfiles`,
			headers: authHeaders(token)
		}, {
			url: endpoint,
			headers: {
				...authHeaders(token),
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles"
			}
		}];
		for (const attempt of attempts) {
			let response;
			try {
				response = await request$2(attempt.url, { max_results: 50 }, attempt.headers, connection.proxyUrl, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				continue;
			}
			if (response.status !== 200) continue;
			const profiles = record$2(response.body)?.profiles;
			if (!Array.isArray(profiles)) continue;
			const valid = [];
			for (const raw of profiles) {
				const value = record$2(raw);
				const candidateArn = value?.arn ?? value?.profileArn;
				if (typeof candidateArn !== "string") continue;
				try {
					valid.push(assertKiroProfileArn(candidateArn));
				} catch {}
			}
			const regional = valid.find((arn) => arn.split(":")[3] === token.region);
			if (regional !== void 0) return regional;
			if (valid[0] !== void 0) return valid[0];
		}
	}
}
/** Infer whether a discovered route should expose Kiro's thinking controls. */
function modelSupportsThinking(modelId) {
	return !/^(?:auto$|claude-sonnet-4$|claude-haiku-|qwen3-coder-next$)/iu.test(modelId);
}
/** Parse the same two effort-schema branches used by the installed Kiro client. */
function parseEffortSchema(schema) {
	const properties = record$2(record$2(schema)?.properties);
	for (const schemaPath of ["output_config", "reasoning"]) {
		const effort = record$2(record$2(record$2(properties?.[schemaPath])?.properties)?.effort);
		const rawLevels = effort?.enum;
		if (!Array.isArray(rawLevels)) continue;
		const levels = [...new Set(rawLevels.filter((level) => typeof level === "string" && level.length > 0))];
		if (levels.length === 0) continue;
		const defaultLevel = typeof effort?.default === "string" && levels.includes(effort.default) ? effort.default : void 0;
		return {
			levels,
			schemaPath,
			...defaultLevel === void 0 ? {} : { defaultLevel }
		};
	}
}
/**
* Read the bounds of the model's advertised `max_tokens` request field.
*
* The field is the only output cap `generateAssistantResponse` honors, and the
* advertised schema is `additionalProperties: false`, so a value outside the
* declared range — or the field itself on a model that does not declare it —
* fails validation. Sending it therefore requires reading these bounds first.
* @param schema - the model's `additionalModelRequestFieldsSchema`.
* @returns the inclusive bounds, or `undefined` when the model declares none.
*/
function parseMaxTokensBounds(schema) {
	const field = record$2(record$2(record$2(schema)?.properties)?.max_tokens);
	if (field === void 0 || field.type !== "integer") return void 0;
	const maximum = positiveInteger(field.maximum);
	if (maximum === void 0) return void 0;
	const minimum = positiveInteger(field.minimum) ?? 1;
	return minimum > maximum ? void 0 : {
		minimum,
		maximum
	};
}
/**
* Parse Kiro's ListAvailableModels response into harness catalog entries.
* @param body - decoded JSON response.
* @returns unique models in provider order.
*/
function parseAvailableModels(body) {
	const models = parseModelPage(body);
	if (models.length === 0) throw new Error("Kiro ListAvailableModels returned no usable model ids");
	return models;
}
/**
* Read the continuation token of one ListAvailableModels page.
* @param body - decoded JSON response.
* @returns the token, or `undefined` when this page is the last.
*/
function modelPageToken(body) {
	const token = record$2(body)?.nextToken;
	return typeof token === "string" && token.length > 0 ? token : void 0;
}
/**
* Parse one page of the model catalog without requiring it to be non-empty:
* a continuation page may legitimately add nothing new.
* @param body - decoded JSON response.
* @returns the page's models in provider order.
*/
function parseModelPage(body) {
	const rawModels = record$2(body)?.models;
	if (!Array.isArray(rawModels)) throw new Error("Kiro ListAvailableModels returned no models array");
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const raw of rawModels) {
		const rawModel = record$2(raw);
		const model = rawModel;
		if (model === void 0 || typeof model.modelId !== "string" || model.modelId.length === 0) continue;
		if (seen.has(model.modelId)) continue;
		seen.add(model.modelId);
		const limits = record$2(model.tokenLimits);
		const contextWindow = positiveInteger(limits?.maxInputTokens);
		const maxTokens = positiveInteger(limits?.maxOutputTokens);
		const inputModalities = parseInputModalities(model.supportedInputTypes);
		const effort = parseEffortSchema(model.additionalModelRequestFieldsSchema);
		const maxTokensBounds = parseMaxTokensBounds(model.additionalModelRequestFieldsSchema);
		const hasEffortSchema = rawModel !== void 0 && Object.hasOwn(rawModel, "additionalModelRequestFieldsSchema");
		models.push({
			id: model.modelId,
			...typeof model.modelName === "string" && model.modelName.length > 0 ? { name: model.modelName } : {},
			...typeof model.description === "string" && model.description.length > 0 ? { description: model.description } : {},
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...inputModalities === void 0 ? {} : { inputModalities },
			thinking: hasEffortSchema ? effort !== void 0 : modelSupportsThinking(model.modelId),
			...effort === void 0 ? {} : {
				reasoningEfforts: effort.levels,
				defaultReasoningEffort: effort.defaultLevel,
				effortSchemaPath: effort.schemaPath
			},
			...maxTokensBounds === void 0 ? {} : { maxTokensBounds }
		});
	}
	return models;
}
function discoveryError(status, body) {
	const value = record$2(body);
	return new LlmError(typeof value?.message === "string" ? value.message : `Kiro model discovery failed (HTTP ${status})`, status === 401 ? "AUTH" : status === 403 ? "FORBIDDEN" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "INVALID_REQUEST", { status });
}
/** Cached account-specific model discovery used by the adapter and web UI. */
var KiroModelDiscovery = class {
	options;
	requestJson;
	profileRequestJson;
	cacheTtlMs;
	cache = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		this.requestJson = options.requestJson ?? getJson;
		this.profileRequestJson = options.profileRequestJson ?? postJsonWithHeaders;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS$1;
	}
	key(connection, region) {
		return `${region}\u0000${connection.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`;
	}
	/** Drop all cached discovery results after login or logout. */
	clear() {
		this.cache.clear();
	}
	endpoint(region) {
		return kiroApiEndpoint(region).url;
	}
	headers(token) {
		return authHeaders(token);
	}
	async discoverProfile(connection, token, region, signal) {
		return discoverKiroProfileArn({
			...connection,
			region
		}, token, signal, this.profileRequestJson);
	}
	/**
	* Return the last discovered catalog for this connection without I/O.
	* @param connection - current connection facts.
	* @returns cached models, if a matching discovery has completed.
	*/
	current(connection) {
		const region = connection.region;
		if (region !== void 0) return this.cache.get(this.key(connection, region))?.models;
		for (const [key, value] of this.cache) if (key.endsWith(`\u0000${connection.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`)) return value.models;
	}
	/**
	* Discover models offered to the signed-in account.
	* @param connection - frozen request facts.
	* @param signal - caller cancellation.
	* @param force - bypass a still-valid cache entry.
	* @returns live Kiro model metadata.
	*/
	async list(connection, signal, force = false) {
		const token = await this.options.resolveToken(connection, signal);
		const authRegion = connection.region ?? token.region;
		const key = this.key(connection, authRegion);
		const cached$1 = this.cache.get(key);
		if (!force && cached$1 !== void 0 && cached$1.expiresAt > Date.now()) return cached$1.models;
		const profileArn = connection.profileArn ?? token.profileArn ?? await this.discoverProfile(connection, token, authRegion, signal);
		const profileRegion$1 = profileArn?.split(":")[3];
		const region = profileRegion$1 !== void 0 && /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(profileRegion$1) ? profileRegion$1 : authRegion;
		const url = new URL(`${this.endpoint(region)}/ListAvailableModels`);
		url.searchParams.set("origin", "AI_EDITOR");
		url.searchParams.set("maxResults", String(PAGE_SIZE));
		if (profileArn !== void 0) url.searchParams.set("profileArn", profileArn);
		const models = [];
		const seen = /* @__PURE__ */ new Set();
		const usedTokens = /* @__PURE__ */ new Set();
		let nextToken;
		for (let page = 0; page < MAX_PAGES; page += 1) {
			let added = 0;
			if (nextToken === void 0) url.searchParams.delete("nextToken");
			else url.searchParams.set("nextToken", nextToken);
			const response = await this.requestJson(url.toString(), this.headers(token), connection.proxyUrl, signal);
			if (response.status !== 200) {
				if (models.length === 0) throw discoveryError(response.status, response.body);
				break;
			}
			for (const model of page === 0 ? parseAvailableModels(response.body) : parseModelPage(response.body)) {
				if (seen.has(model.id)) continue;
				seen.add(model.id);
				models.push(model);
				added += 1;
			}
			nextToken = modelPageToken(response.body);
			if (nextToken === void 0 || usedTokens.has(nextToken) || page > 0 && added === 0) break;
			usedTokens.add(nextToken);
		}
		this.cache.set(key, {
			expiresAt: Date.now() + this.cacheTtlMs,
			models
		});
		return models;
	}
};

//#endregion
//#region lib/types/paths.js
/**
* Return the directory containing credentials created by this plugin.
* @returns an absolute directory below DSH home.
*/
function credentialDirectory() {
	return dshHomePath("storages", "kiro-auth");
}

//#endregion
//#region lib/types/model-settings.js
const MODEL_SETTINGS_FILE = "model-settings.json";
function validIds(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id) => typeof id === "string" && id.length > 0 && !/\s/u.test(id)))];
}
function normalize(value) {
	const record$5 = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	return {
		enabledModelIds: validIds(record$5.enabledModelIds),
		knownModelIds: validIds(record$5.knownModelIds),
		updatedAt: typeof record$5.updatedAt === "number" && Number.isFinite(record$5.updatedAt) ? record$5.updatedAt : 0
	};
}
/** Default storage path; kept beside, but independent from, managed credentials. */
function modelSettingsPath() {
	return join(credentialDirectory(), MODEL_SETTINGS_FILE);
}
/** Sort models by family, newest numeric version, then preferred variant. */
function compareKiroModels(a, b) {
	const family = (model) => {
		const text$3 = `${model.id} ${model.name ?? ""}`.toLowerCase();
		if (text$3.includes("claude")) return 1;
		if (text$3.includes("gpt")) return 2;
		if (text$3.includes("glm")) return 3;
		if (text$3.includes("deepseek")) return 4;
		if (text$3.includes("minimax")) return 5;
		if (text$3.includes("qwen")) return 6;
		if (model.id === "auto") return 8;
		return 7;
	};
	const familyDifference = family(a) - family(b);
	if (familyDifference !== 0) return familyDifference;
	const version = (model) => {
		return (`${model.id} ${model.name ?? ""}`.match(/\b(?:claude|gpt|glm|deepseek|qwen)?[-_ ]*v?(\d+(?:\.\d+)*)/iu)?.[1] ?? "0").split(".").map((part) => Number(part) || 0);
	};
	const left = version(a);
	const right = version(b);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (right[index] ?? 0) - (left[index] ?? 0);
		if (difference !== 0) return difference;
	}
	const variant = (model) => {
		const text$3 = `${model.id} ${model.name ?? ""}`.toLowerCase();
		if (text$3.includes("opus")) return 1;
		if (text$3.includes("sonnet")) return 2;
		if (text$3.includes("haiku")) return 3;
		if (text$3.includes("sol")) return 4;
		if (text$3.includes("terra")) return 5;
		if (text$3.includes("luna")) return 6;
		return 10;
	};
	const variantDifference = variant(a) - variant(b);
	if (variantDifference !== 0) return variantDifference;
	return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
}
/** Serialize model-settings writes so concurrent checkbox changes cannot race. */
var FileModelSettingsStore = class {
	file;
	chain = Promise.resolve();
	constructor(file = modelSettingsPath()) {
		this.file = file;
	}
	async read() {
		try {
			return normalize(JSON.parse(await readFile(this.file, "utf8")));
		} catch (error) {
			if (error.code === "ENOENT") return normalize(void 0);
			throw error;
		}
	}
	async write(settings) {
		const next = {
			...normalize(settings),
			updatedAt: Date.now()
		};
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.tmp`;
		await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 384 });
		await rename(temporary, this.file);
		return next;
	}
	modify(update) {
		const next = (async () => {
			await this.chain.catch(() => {});
			const current = await this.read();
			const updated = update(current);
			return updated === void 0 ? current : this.write(updated);
		})();
		this.chain = next.catch(() => {});
		return next;
	}
	/** Merge a fresh catalog, enabling first-run and newly discovered model ids. */
	mergeCatalog(models) {
		const catalogIds = [...new Set(models.map((model) => model.id))];
		const catalog = new Set(catalogIds);
		return this.modify((current) => {
			const known = new Set(current.knownModelIds);
			const enabled = current.knownModelIds.length === 0 ? catalogIds : [...current.enabledModelIds.filter((id) => catalog.has(id)), ...catalogIds.filter((id) => !known.has(id))];
			const enabledModelIds = [...new Set(enabled)];
			if (enabledModelIds.length === current.enabledModelIds.length && enabledModelIds.every((id, index) => id === current.enabledModelIds[index]) && catalogIds.length === current.knownModelIds.length && catalogIds.every((id, index) => id === current.knownModelIds[index])) return void 0;
			return {
				enabledModelIds,
				knownModelIds: catalogIds,
				updatedAt: current.updatedAt
			};
		});
	}
	/** Persist an exact checkbox selection, constrained to the current catalog. */
	setEnabledModelIds(enabledModelIds, models) {
		const catalogIds = [...new Set(models.map((model) => model.id))];
		const requested = new Set(validIds(enabledModelIds));
		return this.modify((current) => ({
			enabledModelIds: catalogIds.filter((id) => requested.has(id)),
			knownModelIds: catalogIds,
			updatedAt: current.updatedAt
		}));
	}
	/** Resolve enabled models; a missing settings file means all are enabled. */
	async enabledModels(models) {
		const settings = await this.read();
		const enabled = settings.knownModelIds.length === 0 ? new Set(models.map((model) => model.id)) : new Set(settings.enabledModelIds);
		return models.filter((model) => enabled.has(model.id)).sort(compareKiroModels);
	}
};
/** Project a full catalog into the compact checkbox API shape. */
async function modelSelection(store, models) {
	const settings = await store.read();
	const enabled = settings.knownModelIds.length === 0 ? new Set(models.map((model) => model.id)) : new Set(settings.enabledModelIds);
	const projected = models.map((model) => ({
		...model,
		enabled: enabled.has(model.id)
	}));
	projected.sort((a, b) => Number(b.enabled) - Number(a.enabled) || compareKiroModels(a, b));
	return {
		enabledModelIds: projected.filter((model) => model.enabled).map((model) => model.id),
		models: projected
	};
}

//#endregion
//#region lib/types/login.js
const TOKEN_FILE = "kiro-auth-token.json";
const BUILDER_START_URL = "https://view.awsapps.com/start";
const KIRO_ISSUER_URL = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";
const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
const SOCIAL_CLIENT_ID = "kiro-cli";
const SOCIAL_DEVICE_AUTHORIZE_URL = `${KIRO_AUTH_SERVICE}/oauth/device/authorization`;
const SOCIAL_DEVICE_POLL_URL = `${KIRO_AUTH_SERVICE}/oauth/device/poll`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations"
];
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringField(value, camel, snake) {
	const candidate = value[camel] ?? (snake === void 0 ? void 0 : value[snake]);
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : void 0;
}
function numberField(value, camel, snake) {
	const candidate = value[camel] ?? (snake === void 0 ? void 0 : value[snake]);
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : void 0;
}
function providerError(body, fallback) {
	const value = record$1(body);
	if (value === void 0) return fallback;
	return stringField(value, "error_description") ?? stringField(value, "errorDescription") ?? stringField(value, "message") ?? stringField(value, "error") ?? fallback;
}
function startUrl(value) {
	let parsed;
	try {
		parsed = new URL(value.trim());
	} catch (error) {
		throw new Error("Kiro IAM Identity Center start URL is invalid", { cause: error });
	}
	if (parsed.protocol !== "https:" || !(parsed.hostname === "view.awsapps.com" || parsed.hostname.endsWith(".awsapps.com")) || parsed.pathname !== "/start" && parsed.pathname !== "/start/") throw new Error("Kiro IAM Identity Center start URL must be an https://*.awsapps.com/start URL");
	return parsed.toString().replace(/\/$/u, "");
}
/**
* Begin Kiro's coded device authorization for a free or IAM Identity Center account.
*/
async function startDeviceLogin(region, requestJson, signal, options = {}) {
	const selectedRegion = assertKiroRegion(region.trim() || "us-east-1");
	const authMethod = options.authMethod === "idc" ? "idc" : "builder-id";
	const selectedStartUrl = startUrl(authMethod === "idc" ? options.startUrl ?? "" : BUILDER_START_URL);
	const oidcBase = `https://oidc.${selectedRegion}.amazonaws.com`;
	const registration$1 = await requestJson(`${oidcBase}/client/register`, {
		clientName: "kiro-oauth-client",
		clientType: "public",
		scopes: SCOPES,
		grantTypes: [DEVICE_GRANT, "refresh_token"],
		issuerUrl: KIRO_ISSUER_URL
	}, signal);
	if (registration$1.status !== 200) throw new Error(`Kiro client registration failed: ${providerError(registration$1.body, `HTTP ${registration$1.status}`)}`);
	const registered = record$1(registration$1.body);
	const clientId = registered === void 0 ? void 0 : stringField(registered, "clientId", "client_id");
	const clientSecret = registered === void 0 ? void 0 : stringField(registered, "clientSecret", "client_secret");
	if (clientId === void 0 || clientSecret === void 0) throw new Error("Kiro client registration returned no client id or secret");
	const authorization = await requestJson(`${oidcBase}/device_authorization`, {
		clientId,
		clientSecret,
		startUrl: selectedStartUrl
	}, signal);
	if (authorization.status !== 200) throw new Error(`Kiro device authorization failed: ${providerError(authorization.body, `HTTP ${authorization.status}`)}`);
	const authorized = record$1(authorization.body);
	if (authorized === void 0) throw new Error("Kiro device authorization returned an invalid response");
	const deviceCode = stringField(authorized, "deviceCode", "device_code");
	const userCode = stringField(authorized, "userCode", "user_code");
	const verificationUri = stringField(authorized, "verificationUriComplete", "verification_uri_complete") ?? stringField(authorized, "verificationUri", "verification_uri");
	if (deviceCode === void 0 || userCode === void 0 || verificationUri === void 0) throw new Error("Kiro device authorization returned incomplete login details");
	const verificationUrl = new URL(verificationUri);
	if (verificationUrl.protocol !== "https:" || !(verificationUrl.hostname.endsWith(".amazonaws.com") || verificationUrl.hostname.endsWith(".awsapps.com") || verificationUrl.hostname.endsWith(".signin.aws"))) throw new Error(`Kiro returned an unsafe verification URL host: ${verificationUrl.hostname}`);
	const intervalSeconds = Math.max(1, numberField(authorized, "interval") ?? 5);
	const expiresIn = Math.max(1, numberField(authorized, "expiresIn", "expires_in") ?? 600);
	return {
		clientId,
		clientSecret,
		deviceCode,
		userCode,
		verificationUri: verificationUrl.toString(),
		intervalSeconds,
		expiresAt: Date.now() + expiresIn * 1e3,
		region: selectedRegion,
		authMethod,
		startUrl: selectedStartUrl
	};
}
/** Poll one device authorization once. */
async function pollDeviceLogin(session, requestJson, signal) {
	if (Date.now() >= session.expiresAt) throw new Error("Kiro device authorization expired; start login again");
	const response = await requestJson(`https://oidc.${session.region}.amazonaws.com/token`, {
		clientId: session.clientId,
		clientSecret: session.clientSecret,
		grantType: DEVICE_GRANT,
		deviceCode: session.deviceCode
	}, signal);
	const body = record$1(response.body);
	if (response.status === 400) {
		const code = body === void 0 ? void 0 : stringField(body, "error");
		if (code === "authorization_pending") return {
			status: "pending",
			intervalSeconds: session.intervalSeconds
		};
		if (code === "slow_down") return {
			status: "pending",
			intervalSeconds: session.intervalSeconds + 5
		};
		if (code === "access_denied") throw new Error("Kiro device authorization was denied");
		if (code === "expired_token") throw new Error("Kiro device authorization expired; start login again");
	}
	if (response.status !== 200 || body === void 0) throw new Error(`Kiro token request failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const accessToken = stringField(body, "accessToken", "access_token");
	const refreshToken = stringField(body, "refreshToken", "refresh_token");
	if (accessToken === void 0 || refreshToken === void 0) throw new Error("Kiro token response returned incomplete credentials");
	const expiresIn = Math.max(1, numberField(body, "expiresIn", "expires_in") ?? 3600);
	const profileArn = stringField(body, "profileArn", "profile_arn");
	return {
		status: "completed",
		credentials: {
			accessToken,
			refreshToken,
			expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
			clientId: session.clientId,
			clientSecret: session.clientSecret,
			region: session.region,
			authMethod: session.authMethod,
			startUrl: session.startUrl,
			...profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(profileArn) }
		}
	};
}
/** Begin Kiro's headless Google or GitHub device authorization. */
async function startSocialDeviceLogin(provider, requestJson, signal) {
	const loginProvider = provider === "google" ? "Google" : "Github";
	const response = await requestJson(SOCIAL_DEVICE_AUTHORIZE_URL, {
		clientId: SOCIAL_CLIENT_ID,
		loginProvider
	}, signal);
	if (response.status !== 200) throw new Error(`Kiro social device authorization failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const body = record$1(response.body);
	const deviceCode = body === void 0 ? void 0 : stringField(body, "deviceCode", "device_code");
	const userCode = body === void 0 ? void 0 : stringField(body, "userCode", "user_code");
	const verificationUri = body === void 0 ? void 0 : stringField(body, "verificationUriComplete", "verification_uri_complete");
	if (deviceCode === void 0 || userCode === void 0 || verificationUri === void 0) throw new Error("Kiro social device authorization returned incomplete login details");
	const verificationUrl = new URL(verificationUri);
	if (verificationUrl.protocol !== "https:" || verificationUrl.hostname !== "app.kiro.dev" || verificationUrl.pathname !== "/account/device" || verificationUrl.searchParams.get("user_code") !== userCode || verificationUrl.searchParams.get("login_provider") !== loginProvider) throw new Error("Kiro returned an unexpected social verification URL");
	const intervalMilliseconds = Math.max(1, body === void 0 ? 5e3 : numberField(body, "intervalInMilliseconds", "interval_in_milliseconds") ?? 5e3);
	const expiresInMilliseconds = Math.max(1, body === void 0 ? 3e5 : numberField(body, "expiresInMilliseconds", "expires_in_milliseconds") ?? 3e5);
	return {
		provider,
		deviceCode,
		userCode,
		verificationUri: verificationUrl.toString(),
		intervalSeconds: Math.max(1, Math.ceil(intervalMilliseconds / 1e3)),
		expiresAt: Date.now() + expiresInMilliseconds
	};
}
/** Poll one Kiro Google/GitHub device authorization once. */
async function pollSocialDeviceLogin(session, requestJson, signal) {
	if (Date.now() >= session.expiresAt) throw new Error("Kiro social device authorization expired; start login again");
	const response = await requestJson(SOCIAL_DEVICE_POLL_URL, {
		clientId: SOCIAL_CLIENT_ID,
		deviceCode: session.deviceCode
	}, signal);
	const body = record$1(response.body);
	const progress = body === void 0 ? void 0 : stringField(body, "error") ?? stringField(body, "status");
	if (progress === "authorization_pending") return {
		status: "pending",
		intervalSeconds: session.intervalSeconds
	};
	if (progress === "slow_down") return {
		status: "pending",
		intervalSeconds: session.intervalSeconds + 5
	};
	if (response.status !== 200 || body === void 0) throw new Error(`Kiro social device token request failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const accessToken = stringField(body, "accessToken", "access_token");
	const refreshToken = stringField(body, "refreshToken", "refresh_token");
	if (accessToken === void 0 || refreshToken === void 0) throw new Error(`Kiro social device token request failed: ${progress ?? "incomplete token response"}`);
	const expiresIn = Math.max(1, numberField(body, "expiresIn", "expires_in") ?? 3600);
	const profileArn = stringField(body, "profileArn", "profile_arn");
	return {
		status: "completed",
		credentials: {
			accessToken,
			refreshToken,
			expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
			region: "us-east-1",
			authMethod: session.provider,
			...profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(profileArn) }
		}
	};
}
/**
* Resolve the credential origin for one refresh-token import.
* @param requested - the explicit origin the caller named, if any.
* @param hasClientCredentials - whether an OIDC client id and secret were supplied.
* @param resolvedStartUrl - the normalized start URL, if any.
* @returns the origin to record.
* @throws when the named origin contradicts the supplied credentials.
*/
function resolveRefreshTokenOrigin(requested, hasClientCredentials, resolvedStartUrl) {
	if (requested === "imported" && hasClientCredentials) throw new Error("Kiro refresh-token import: an imported Kiro token refreshes against Kiro's own service and takes no OIDC client id or secret");
	if ((requested === "builder-id" || requested === "idc") && !hasClientCredentials) throw new Error(`Kiro refresh-token import: ${requested} credentials refresh through AWS OIDC and require their client id and client secret`);
	if (requested === "idc" && resolvedStartUrl === void 0) throw new Error("Kiro refresh-token import: IAM Identity Center credentials require their start URL");
	if (requested !== void 0) return requested;
	if (!hasClientCredentials) return "imported";
	return resolvedStartUrl !== void 0 && resolvedStartUrl !== BUILDER_START_URL ? "idc" : "builder-id";
}
/** Validate and refresh an imported Kiro refresh token. */
async function importRefreshToken(input, requestJson, signal) {
	const refreshToken = input.refreshToken.trim();
	if (refreshToken.length === 0) throw new Error("Kiro refresh token is required");
	if (input.clientId === void 0 !== (input.clientSecret === void 0)) throw new Error("Kiro client id and client secret must be provided together");
	const region = assertKiroRegion(input.region?.trim() || "us-east-1");
	const hasClientCredentials = input.clientId !== void 0 && input.clientSecret !== void 0;
	const resolvedStartUrl = input.startUrl === void 0 || input.startUrl.trim().length === 0 ? void 0 : startUrl(input.startUrl);
	const origin = resolveRefreshTokenOrigin(input.authMethod, hasClientCredentials, resolvedStartUrl);
	const viaAwsOidc = origin === "builder-id" || origin === "idc";
	const response = await requestJson(viaAwsOidc ? `https://oidc.${region}.amazonaws.com/token` : `${KIRO_AUTH_SERVICE}/refreshToken`, viaAwsOidc ? {
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		refreshToken,
		grantType: "refresh_token"
	} : { refreshToken }, signal);
	if (response.status !== 200) throw new Error(`Kiro refresh-token import failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const body = record$1(response.body);
	const accessToken = body === void 0 ? void 0 : stringField(body, "accessToken", "access_token");
	if (accessToken === void 0) throw new Error("Kiro refresh-token import returned no access token");
	const rotated = body === void 0 ? void 0 : stringField(body, "refreshToken", "refresh_token");
	const expiresIn = Math.max(1, body === void 0 ? 3600 : numberField(body, "expiresIn", "expires_in") ?? 3600);
	const responseProfile = body === void 0 ? void 0 : stringField(body, "profileArn", "profile_arn");
	const selectedProfile = input.profileArn?.trim() || responseProfile;
	return {
		accessToken,
		refreshToken: rotated ?? refreshToken,
		expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
		region,
		authMethod: origin,
		...viaAwsOidc ? {
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			startUrl: resolvedStartUrl ?? BUILDER_START_URL
		} : {},
		...selectedProfile === void 0 ? {} : { profileArn: assertKiroProfileArn(selectedProfile) }
	};
}
/** Validate a long-lived Kiro API key against its actual model catalog. */
async function importApiKey(apiKey, regionValue, requestGet, signal) {
	const accessToken = apiKey.trim();
	if (accessToken.length === 0) throw new Error("Kiro API key is required");
	const region = assertKiroRegion(regionValue?.trim() || "us-east-1");
	const url = new URL(`${kiroApiEndpoint(region).url}/ListAvailableModels`);
	url.searchParams.set("origin", "AI_EDITOR");
	const response = await requestGet(url.toString(), {
		authorization: `Bearer ${accessToken}`,
		TokenType: "API_KEY",
		"user-agent": "aws-sdk-js/3.738.0 KiroIDE",
		"x-amz-user-agent": "aws-sdk-js/3.738.0 KiroIDE"
	}, signal);
	const models = record$1(response.body)?.models;
	if (response.status !== 200 || !Array.isArray(models) || models.length === 0) throw new Error("Kiro API key validation failed");
	return {
		credentials: {
			accessToken,
			expiresAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1e3).toISOString(),
			region,
			authMethod: "api_key"
		},
		models: models.length
	};
}
/** Convert CLIProxyAPI-compatible Microsoft external-IdP JSON into managed credentials. */
function importExternalIdp(raw) {
	return normalizeExternalIdpCredentials(raw);
}
async function atomicJson(path, value) {
	const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, path);
}
/** Save any normalized credential beneath DSH home with private permissions. */
async function saveManagedCredentials(directory, credentials) {
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	let clientIdHash;
	if (credentials.clientId !== void 0 && credentials.clientSecret !== void 0) {
		clientIdHash = createHash("sha256").update(credentials.clientId).digest("hex");
		await atomicJson(join(directory, `${clientIdHash}.json`), {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret
		});
	}
	await atomicJson(join(directory, TOKEN_FILE), {
		accessToken: credentials.accessToken,
		...credentials.refreshToken === void 0 ? {} : { refreshToken: credentials.refreshToken },
		expiresAt: credentials.expiresAt,
		region: credentials.region,
		authMethod: credentials.authMethod,
		...credentials.profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(credentials.profileArn) },
		...clientIdHash === void 0 ? {} : { clientIdHash },
		...credentials.clientId === void 0 || credentials.clientSecret !== void 0 ? {} : { clientId: credentials.clientId },
		...credentials.startUrl === void 0 ? {} : { startUrl: credentials.startUrl },
		...credentials.tokenEndpoint === void 0 ? {} : { tokenEndpoint: credentials.tokenEndpoint },
		...credentials.scope === void 0 ? {} : { scope: credentials.scope }
	});
	clearTokenCache();
}
function saveDeviceCredentials(directory, credentials) {
	return saveManagedCredentials(directory, credentials);
}
/** Read only non-secret managed credential metadata for the status API. */
async function credentialSummary(directory) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(join(directory, TOKEN_FILE), "utf8"));
	} catch {
		return { authenticated: false };
	}
	const value = record$1(parsed);
	if (value === void 0) return { authenticated: false };
	const accessToken = stringField(value, "accessToken", "access_token");
	const refreshToken = stringField(value, "refreshToken", "refresh_token");
	const expiresAt = stringField(value, "expiresAt", "expires_at");
	const region = stringField(value, "region");
	const recorded = stringField(value, "authMethod", "auth_method");
	const method = recorded === void 0 ? void 0 : kiroAuthMethod(recorded, value);
	const profileArn = stringField(value, "profileArn", "profile_arn");
	return {
		authenticated: accessToken !== void 0 || refreshToken !== void 0,
		...expiresAt === void 0 ? {} : { expiresAt },
		...region === void 0 ? {} : { region },
		...method === void 0 ? {} : { authMethod: method },
		...profileArn === void 0 ? {} : { profileArn }
	};
}
async function unlinkIfPresent(path) {
	try {
		await unlink(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
/** Delete only credentials owned by this plugin, leaving Kiro IDE files intact. */
async function deleteDeviceCredentials(directory) {
	let clientIdHash;
	try {
		const parsed = record$1(JSON.parse(await readFile(join(directory, TOKEN_FILE), "utf8")));
		const candidate = parsed === void 0 ? void 0 : stringField(parsed, "clientIdHash");
		if (candidate !== void 0 && /^[a-f0-9]{64}$/u.test(candidate)) clientIdHash = candidate;
	} catch (error) {
		if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
	}
	await unlinkIfPresent(join(directory, TOKEN_FILE));
	if (clientIdHash !== void 0) await unlinkIfPresent(join(directory, `${clientIdHash}.json`));
	clearTokenCache();
}

//#endregion
//#region lib/types/web.js
function sendJson(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	response.end(JSON.stringify(body));
}
function safeError(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/(?:access|refresh|client|api)[_-]?(?:token|secret|key)\s*[:=]\s*\S+/giu, "[redacted credential]").replace(/aorAAAAAG[A-Za-z0-9._~-]+/gu, "[redacted refresh token]");
}
async function readJson(request$2, maximumBytes = 1048576) {
	const chunks = [];
	let bytes = 0;
	for await (const raw of request$2) {
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		bytes += chunk.byteLength;
		if (bytes > maximumBytes) throw new Error("Kiro request body is too large");
		chunks.push(chunk);
	}
	if (bytes === 0) return {};
	let value;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		throw new Error("Kiro request body is not valid JSON", { cause: error });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Kiro request body must be a JSON object");
	return value;
}
function optionalText(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function requiredText(value, name$1) {
	const result = optionalText(value);
	if (result === void 0) throw new Error(`${name$1} is required`);
	return result;
}
/**
* Narrow the credential origin an import request names.
* @param value - the request field, if the caller sent one.
* @returns the origin, or `undefined` to let the importer derive it.
* @throws when the caller names an origin this importer does not support.
*/
function refreshTokenOrigin(value) {
	const named = optionalText(value);
	if (named === void 0) return void 0;
	if (named === "builder-id" || named === "idc" || named === "imported") return named;
	throw new Error(`Unsupported Kiro refresh-token credential source "${named}"`);
}
function publicLogin(flow) {
	if (flow === void 0) return { status: "idle" };
	return {
		status: flow.status,
		kind: flow.kind,
		method: flow.method,
		startedAt: flow.startedAt,
		...flow.completedAt === void 0 ? {} : { completedAt: flow.completedAt },
		...flow.authUrl === void 0 ? {} : { authUrl: flow.authUrl },
		...flow.userCode === void 0 ? {} : { userCode: flow.userCode },
		...flow.error === void 0 ? {} : { error: flow.error }
	};
}
async function modelPayload(models, source, store) {
	const selection = await modelSelection(store, models);
	return {
		source,
		fetchedAt: Date.now(),
		enabledModelIds: selection.enabledModelIds,
		models: selection.models.map((model) => ({
			id: model.id,
			name: model.name ?? model.id,
			description: model.description,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			thinking: model.thinking ?? true,
			reasoningEfforts: model.reasoningEfforts ?? (model.thinking === false ? ["off"] : [
				"off",
				"low",
				"medium",
				"high"
			]),
			defaultReasoningEffort: model.defaultReasoningEffort,
			enabled: model.enabled
		}))
	};
}
/** Register the optional DSH Web management API. */
function registerWebApi(ctx, dependencies) {
	let login;
	let loginController;
	const emitUpdated = () => {
		try {
			ctx.emit("llm/adapters-updated");
		} catch (error) {
			ctx.logger.warn(`dsh-kiro: model update event failed: ${safeError(error)}`);
		}
	};
	const status = async () => {
		const managed = await credentialSummary(dependencies.managedDirectory);
		const external = managed.authenticated ? {
			authenticated: false,
			authMethod: void 0,
			region: void 0,
			expiresAt: void 0,
			profileArn: void 0
		} : await credentialSummary(kiroCredentialDirectory());
		const connection = dependencies.options();
		const cached$1 = dependencies.discovery.current(connection);
		return {
			authenticated: managed.authenticated || external.authenticated,
			credentialSource: managed.authenticated ? "dsh" : external.authenticated ? "kiro" : "none",
			authMethod: managed.authMethod ?? external.authMethod,
			region: managed.region ?? external.region ?? connection.region,
			expiresAt: managed.expiresAt ?? external.expiresAt,
			profileArn: connection.profileArn ?? managed.profileArn ?? external.profileArn,
			login: publicLogin(login),
			models: await modelPayload(cached$1 ?? connection.models, cached$1 === void 0 ? "configured" : "live", dependencies.modelSettings),
			usage: dependencies.usage.current(connection)
		};
	};
	const save = async (credentials, signal) => {
		let complete = credentials;
		if (credentials.profileArn === void 0 && credentials.authMethod !== "api_key") try {
			const profileArn = await discoverKiroProfileArn(dependencies.options(), {
				accessToken: credentials.accessToken,
				region: credentials.region,
				expiresAt: Date.parse(credentials.expiresAt),
				authMethod: credentials.authMethod
			}, signal);
			if (profileArn !== void 0) complete = {
				...credentials,
				profileArn
			};
		} catch (error) {
			ctx.logger.warn(`dsh-kiro: profile ARN discovery after login failed: ${safeError(error)}`);
		}
		await saveManagedCredentials(dependencies.managedDirectory, complete);
		dependencies.discovery.clear();
		dependencies.usage.clear();
		emitUpdated();
	};
	const finish = async (credentials, flow, signal) => {
		await save(credentials, signal);
		login = {
			status: "complete",
			kind: flow.kind,
			method: flow.method,
			...flow.authUrl === void 0 ? {} : { authUrl: flow.authUrl },
			...flow.userCode === void 0 ? {} : { userCode: flow.userCode },
			startedAt: flow.startedAt,
			completedAt: Date.now()
		};
	};
	const monitorLogin = (initialIntervalSeconds, flow, controller, poll) => {
		(async () => {
			let intervalSeconds = initialIntervalSeconds;
			try {
				while (!controller.signal.aborted) {
					await new Promise((resolve, reject) => {
						const onAbort = () => {
							clearTimeout(timer);
							reject(/* @__PURE__ */ new Error("Kiro login cancelled"));
						};
						const timer = setTimeout(() => {
							controller.signal.removeEventListener("abort", onAbort);
							resolve();
						}, intervalSeconds * 1e3);
						controller.signal.addEventListener("abort", onAbort, { once: true });
					});
					const result = await poll();
					if (result.status === "pending") {
						intervalSeconds = result.intervalSeconds;
						continue;
					}
					await finish(result.credentials, flow, controller.signal);
					return;
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				login = {
					...flow,
					status: "error",
					completedAt: Date.now(),
					error: safeError(error)
				};
			}
		})();
	};
	const beginDevice = async (body) => {
		loginController?.abort("starting a new Kiro login");
		const controller = new AbortController();
		loginController = controller;
		if (body.method !== "builder-id" && body.method !== "idc") throw new Error("Unsupported Kiro device login method");
		const method = body.method;
		const connection = dependencies.options();
		const region = optionalText(body.region) ?? connection.region ?? "us-east-1";
		const requestJson = (url, value, signal) => postJson(url, value, connection.proxyUrl, signal);
		const session = await startDeviceLogin(region, requestJson, controller.signal, {
			authMethod: method,
			...method === "idc" ? { startUrl: requiredText(body.startUrl, "IAM Identity Center start URL") } : {}
		});
		const flow = {
			status: "pending",
			kind: "device",
			method,
			authUrl: session.verificationUri,
			userCode: session.userCode,
			startedAt: Date.now()
		};
		login = flow;
		monitorLogin(session.intervalSeconds, flow, controller, () => pollDeviceLogin(session, requestJson, controller.signal));
		return publicLogin(login);
	};
	const beginSocialDevice = async (method) => {
		loginController?.abort("starting a new Kiro login");
		const controller = new AbortController();
		loginController = controller;
		const connection = dependencies.options();
		const requestJson = (url, value, signal) => postJson(url, value, connection.proxyUrl, signal);
		const session = await startSocialDeviceLogin(method, requestJson, controller.signal);
		const flow = {
			status: "pending",
			kind: "social-device",
			method,
			authUrl: session.verificationUri,
			userCode: session.userCode,
			startedAt: Date.now()
		};
		login = flow;
		monitorLogin(session.intervalSeconds, flow, controller, () => pollSocialDeviceLogin(session, requestJson, controller.signal));
		return publicLogin(login);
	};
	const importCredential = async (body) => {
		loginController?.abort("importing Kiro credentials");
		loginController = void 0;
		const connection = dependencies.options();
		const signal = AbortSignal.timeout(3e4);
		const method = requiredText(body.method, "Kiro import method");
		let credentials;
		let verified;
		if (method === "refresh-token") {
			const region = optionalText(body.region) ?? connection.region;
			const profileArn = optionalText(body.profileArn);
			const clientId = optionalText(body.clientId);
			const clientSecret = optionalText(body.clientSecret);
			const startUrl$1 = optionalText(body.startUrl);
			const origin = refreshTokenOrigin(body.credentialSource ?? body.authMethod);
			credentials = await importRefreshToken({
				refreshToken: requiredText(body.refreshToken, "Kiro refresh token"),
				...region === void 0 ? {} : { region },
				...profileArn === void 0 ? {} : { profileArn },
				...clientId === void 0 ? {} : { clientId },
				...clientSecret === void 0 ? {} : { clientSecret },
				...startUrl$1 === void 0 ? {} : { startUrl: startUrl$1 },
				...origin === void 0 ? {} : { authMethod: origin }
			}, (url, value, requestSignal) => postJson(url, value, connection.proxyUrl, requestSignal), signal);
			verified = { refreshed: true };
		} else if (method === "api-key") {
			const checked = await importApiKey(requiredText(body.apiKey, "Kiro API key"), optionalText(body.region) ?? connection.region, (url, headers$1, requestSignal) => getJson(url, headers$1, connection.proxyUrl, requestSignal), signal);
			credentials = checked.credentials;
			verified = { models: checked.models };
		} else if (method === "external-idp") credentials = importExternalIdp(body.credentials);
		else throw new Error("Unsupported Kiro import method");
		await save(credentials, signal);
		login = void 0;
		const current = await status();
		return verified === void 0 ? current : {
			...current,
			verified
		};
	};
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => {
			const dispose = webCtx.webServer.register({
				kind: "prefix",
				path: "/kiro/api",
				handler: async (request$2, response) => {
					const path = new URL(request$2.url ?? "/", "http://dsh.local").pathname.replace(/^\/kiro\/api\/?/u, "");
					try {
						if ((path === "" || path === "status") && request$2.method === "GET") {
							sendJson(response, 200, {
								ok: true,
								value: await status()
							});
							return;
						}
						if (path === "login" && request$2.method === "POST") {
							const body = await readJson(request$2);
							const method = optionalText(body.method) ?? "builder-id";
							sendJson(response, 200, {
								ok: true,
								value: method === "google" || method === "github" ? await beginSocialDevice(method) : await beginDevice({
									...body,
									method
								})
							});
							return;
						}
						if (path === "login/cancel" && request$2.method === "POST") {
							loginController?.abort("Kiro login cancelled");
							loginController = void 0;
							login = void 0;
							sendJson(response, 200, {
								ok: true,
								value: await status()
							});
							return;
						}
						if (path === "credentials/import" && request$2.method === "POST") {
							sendJson(response, 200, {
								ok: true,
								value: await importCredential(await readJson(request$2))
							});
							return;
						}
						if (path === "logout" && request$2.method === "POST") {
							loginController?.abort("Kiro logout");
							login = void 0;
							await deleteDeviceCredentials(dependencies.managedDirectory);
							dependencies.discovery.clear();
							dependencies.usage.clear();
							emitUpdated();
							sendJson(response, 200, {
								ok: true,
								value: await status()
							});
							return;
						}
						if (path === "models" && request$2.method === "GET") {
							const connection = dependencies.options();
							const cached$1 = dependencies.discovery.current(connection);
							sendJson(response, 200, {
								ok: true,
								value: await modelPayload(cached$1 ?? connection.models, cached$1 === void 0 ? "configured" : "live", dependencies.modelSettings)
							});
							return;
						}
						if (path === "models" && request$2.method === "POST") {
							const body = await readJson(request$2);
							if (!Array.isArray(body.enabledModelIds) || !body.enabledModelIds.every((id) => typeof id === "string")) {
								sendJson(response, 400, {
									ok: false,
									error: "enabledModelIds must be an array of strings"
								});
								return;
							}
							const connection = dependencies.options();
							const cached$1 = dependencies.discovery.current(connection);
							const models = cached$1 ?? connection.models;
							await dependencies.modelSettings.setEnabledModelIds(body.enabledModelIds, models);
							emitUpdated();
							sendJson(response, 200, {
								ok: true,
								value: await modelPayload(models, cached$1 === void 0 ? "configured" : "live", dependencies.modelSettings)
							});
							return;
						}
						if (path === "models/refresh" && request$2.method === "POST") {
							const connection = dependencies.options();
							const models = await dependencies.discovery.list(connection, AbortSignal.timeout(15e3), true);
							await dependencies.modelSettings.mergeCatalog(models);
							emitUpdated();
							sendJson(response, 200, {
								ok: true,
								value: await modelPayload(models, "live", dependencies.modelSettings)
							});
							return;
						}
						if (path === "usage" && (request$2.method === "GET" || request$2.method === "POST")) {
							const connection = dependencies.options();
							sendJson(response, 200, {
								ok: true,
								value: await dependencies.usage.get(connection, AbortSignal.timeout(15e3), request$2.method === "POST")
							});
							return;
						}
						if (["GET", "POST"].includes(request$2.method ?? "")) {
							sendJson(response, 404, {
								ok: false,
								error: "not-found"
							});
							return;
						}
						sendJson(response, 405, {
							ok: false,
							error: "method-not-allowed"
						});
					} catch (error) {
						sendJson(response, 500, {
							ok: false,
							error: safeError(error)
						});
					}
				}
			});
			return () => {
				loginController?.abort("dsh-kiro web API disposed");
				dispose();
			};
		}, "dsh-kiro: web API");
	});
}

//#endregion
//#region lib/types/usage.js
const DEFAULT_CACHE_TTL_MS = 300 * 1e3;
const KIRO_USER_AGENT = "aws-sdk-js/3.738.0 KiroIDE";
/**
* Limit value Kiro publishes for a plan with no usable bound. The installed
* client treats a limit at or above it as "no limit" rather than a quota, so
* converting it into a percentage would invent a ceiling the account does not have.
*/
const NO_LIMIT_SENTINEL = 999999;
/** Bonus states that still describe real, displayable balance. */
const DISPLAYABLE_BONUS_STATES = new Set(["ACTIVE", "EXHAUSTED"]);
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function numeric(...values) {
	for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
	return 0;
}
function timestamp(value) {
	let milliseconds;
	if (typeof value === "number" && Number.isFinite(value)) milliseconds = value < 1e10 ? value * 1e3 : value;
	else if (typeof value === "string" && value.length > 0) {
		const asNumber = Number(value);
		milliseconds = Number.isFinite(asNumber) ? asNumber < 1e10 ? asNumber * 1e3 : asNumber : Date.parse(value);
	} else return;
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : void 0;
}
function percentage(value) {
	return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
/**
* Build one usage row, treating an absent or sentinel limit as unbounded.
* @param id - stable row identifier.
* @param label - display label.
* @param used - amount consumed.
* @param limit - reported bound, possibly Kiro's no-limit sentinel.
* @param resetAt - when the bound resets or the grant expires.
* @param kind - which balance this row describes.
* @returns the normalized row.
*/
function row(id, label, used, limit, resetAt, kind) {
	const bounded = limit > 0 && limit < NO_LIMIT_SENTINEL;
	const remaining = bounded ? Math.max(0, limit - used) : 0;
	return {
		id,
		label,
		used,
		limit,
		remaining,
		usedPercent: bounded ? percentage(used / limit * 100) : 0,
		remainingPercent: bounded ? percentage(remaining / limit * 100) : 0,
		...resetAt === void 0 ? {} : { resetAt },
		kind,
		...bounded ? {} : { unlimited: true }
	};
}
/** Slug one label into a stable row-id fragment. */
function slug(value, fallback) {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
	return cleaned.length === 0 ? fallback : cleaned;
}
/**
* Normalize the public quota response without retaining account identity fields.
*
* Every structure the installed Kiro client reads is covered: subscription
* breakdowns, the welcome trial (only while the provider calls it `ACTIVE`),
* named bonus grants, and purchased overage credit packs. Unknown or unbounded
* limits are marked, never converted into a percentage.
* @param value - the decoded GetUsageLimits response.
* @param now - current epoch milliseconds, injectable for tests.
* @returns the normalized usage snapshot.
*/
function parseKiroUsage(value, now = Date.now()) {
	const root = record(value);
	const breakdowns = root?.usageBreakdownList;
	if (!Array.isArray(breakdowns)) throw new Error("Kiro GetUsageLimits returned no usage breakdown");
	const resetAt = timestamp(root?.nextDateReset ?? root?.resetDate);
	const rows = [];
	for (const raw of breakdowns) {
		const item = record(raw);
		if (item === void 0) continue;
		const resourceType = text(item.resourceType) ?? `usage-${rows.length + 1}`;
		const prefix = resourceType.toLowerCase();
		const label = text(item.displayNamePlural) ?? text(item.displayName) ?? resourceType;
		rows.push(row(prefix, label, numeric(item.currentUsageWithPrecision, item.currentUsage), numeric(item.usageLimitWithPrecision, item.usageLimit), resetAt, "subscription"));
		const trial = record(item.freeTrialInfo);
		if (trial !== void 0 && text(trial.freeTrialStatus) === "ACTIVE") rows.push(row(`${prefix}-welcome-bonus`, "Welcome bonus", numeric(trial.currentUsageWithPrecision, trial.currentUsage), numeric(trial.usageLimitWithPrecision, trial.usageLimit), timestamp(trial.freeTrialExpiry) ?? resetAt, "bonus"));
		if (Array.isArray(item.bonuses)) for (const [index, rawBonus] of item.bonuses.entries()) {
			const bonus = record(rawBonus);
			if (bonus === void 0) continue;
			const status = text(bonus.status);
			if (status !== void 0 && !DISPLAYABLE_BONUS_STATES.has(status)) continue;
			const name$1 = text(bonus.displayName) ?? "Bonus";
			rows.push(row(`${prefix}-bonus-${slug(name$1, String(index + 1))}`, name$1, numeric(bonus.currentUsageWithPrecision, bonus.currentUsage), numeric(bonus.usageLimitWithPrecision, bonus.usageLimit), timestamp(bonus.expiresAt) ?? resetAt, "bonus"));
		}
		if (Array.isArray(item.overageCredits)) for (const [index, rawPack] of item.overageCredits.entries()) {
			const pack = record(rawPack);
			if (pack === void 0) continue;
			const expiresAt = timestamp(pack.expiresAt);
			if (expiresAt !== void 0 && Date.parse(expiresAt) <= now) continue;
			rows.push(row(`${prefix}-addon-${index + 1}`, text(pack.displayName) ?? "Add-on credits", numeric(pack.currentUsageWithPrecision, pack.currentUsage), numeric(pack.usageLimitWithPrecision, pack.usageLimit), expiresAt ?? resetAt, "addon"));
		}
	}
	if (rows.length === 0) throw new Error("Kiro GetUsageLimits returned no usable usage rows");
	return {
		plan: text(record(root?.subscriptionInfo)?.subscriptionTitle) ?? "Kiro",
		fetchedAt: now,
		...resetAt === void 0 ? {} : { resetAt },
		rows
	};
}
function tokenTypeHeaders(authMethod) {
	if (authMethod === "api_key") return { TokenType: "API_KEY" };
	if (authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
function headers(token) {
	return {
		authorization: `Bearer ${token.accessToken}`,
		"user-agent": KIRO_USER_AGENT,
		"x-amz-user-agent": KIRO_USER_AGENT,
		...tokenTypeHeaders(token.authMethod)
	};
}
/** Account-scoped five-minute usage cache with forced refresh support. */
var KiroUsageService = class {
	options;
	getRequest;
	postRequest;
	cacheTtlMs;
	cache = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		this.getRequest = options.getRequest ?? getJson;
		this.postRequest = options.postRequest ?? postJsonWithHeaders;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	}
	key(connection, token) {
		return `${connection.region ?? token.region}\u0000${connection.profileArn ?? token.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`;
	}
	clear() {
		this.cache.clear();
	}
	current(connection) {
		const suffix = `\u0000${connection.proxyUrl ?? ""}`;
		const prefix = connection.region === void 0 ? void 0 : `${connection.region}\u0000`;
		for (const [key, entry] of this.cache) if (key.endsWith(suffix) && (prefix === void 0 || key.startsWith(prefix))) return entry.usage;
	}
	async get(connection, signal, force = false) {
		const token = await this.options.resolveToken(connection, signal);
		const key = this.key(connection, token);
		const cached$1 = this.cache.get(key);
		if (!force && cached$1 !== void 0 && cached$1.expiresAt > Date.now()) return cached$1.usage;
		const region = connection.region ?? token.region;
		const profileArn = connection.profileArn ?? token.profileArn;
		const codeWhispererQuery = new URLSearchParams({
			isEmailRequired: "true",
			origin: "AI_EDITOR",
			resourceType: "AGENTIC_REQUEST"
		});
		const qQuery = new URLSearchParams({
			origin: "AI_EDITOR",
			resourceType: "AGENTIC_REQUEST",
			...profileArn === void 0 ? {} : { profileArn }
		});
		const commonHeaders = headers(token);
		const base = kiroApiEndpoint(region).url;
		const attempts = [
			() => this.getRequest(`${base}/getUsageLimits?${codeWhispererQuery.toString()}`, commonHeaders, connection.proxyUrl, signal),
			() => this.postRequest(base, {
				origin: "AI_EDITOR",
				resourceType: "AGENTIC_REQUEST",
				...profileArn === void 0 ? {} : { profileArn }
			}, {
				...commonHeaders,
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": "AmazonCodeWhispererService.GetUsageLimits"
			}, connection.proxyUrl, signal),
			() => this.getRequest(`${base}/getUsageLimits?${qQuery.toString()}`, commonHeaders, connection.proxyUrl, signal)
		];
		let lastStatus = 0;
		let lastError;
		for (const attempt of attempts) try {
			const response = await attempt();
			lastStatus = response.status;
			if (response.status !== 200) continue;
			const usage = parseKiroUsage(response.body);
			this.cache.set(key, {
				expiresAt: Date.now() + this.cacheTtlMs,
				usage
			});
			return usage;
		} catch (error) {
			if (signal.aborted) throw error;
			lastError = error;
		}
		const code = lastStatus === 401 ? "AUTH" : lastStatus === 403 ? "FORBIDDEN" : lastStatus === 429 ? "RATE_LIMIT" : lastStatus >= 500 ? "SERVER" : "TRANSPORT";
		throw new LlmError(lastStatus > 0 ? `Kiro usage is temporarily unavailable (HTTP ${lastStatus})` : "Kiro usage is temporarily unavailable", code, {
			...lastStatus > 0 ? { status: lastStatus } : {},
			...lastError === void 0 ? {} : { cause: lastError }
		});
	}
};

//#endregion
//#region lib/types/index.js
const name = "dsh-kiro";
const inject = ["llm"];
const NS = settingsNamespace("llm-kiro");
/** The single provider route this plugin owns. */
const PROVIDER = "kiro";
/** Refresh a token this long before its actual expiry. */
const DEFAULT_TOKEN_EXPIRY_BUFFER_MS = 3e5;
/** Long-context Claude variants Kiro publishes with a 1M window. */
const CONTEXT_1M = 1e6;
/**
* Models this account tier reaches, each verified against the live service.
* Claude entries need authorized egress; the open-weight entries answer from
* any. `minimax-m2.1` is absent because the service reports it temporarily
* unavailable, and the `-1m` variants of Sonnet 4.5, Sonnet 5, and Opus 4.8
* are absent because it refuses them as unknown ids — an unlisted id still
* passes through, so a tier that serves them needs no code change.
*/
const VISION = ["text", "image"];
const TEXT_ONLY = ["text"];
const DEFAULT_MODELS = [
	{
		id: "auto",
		name: "Auto",
		thinking: false,
		inputModalities: VISION
	},
	{
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		thinking: false,
		inputModalities: VISION
	},
	{
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4.5",
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-sonnet-4.6-1m",
		name: "Claude Sonnet 4.6 (1M)",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-opus-4.5",
		name: "Claude Opus 4.5",
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-opus-4.6",
		name: "Claude Opus 4.6",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-opus-4.6-1m",
		name: "Claude Opus 4.6 (1M)",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-opus-4.7",
		name: "Claude Opus 4.7",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		contextWindow: CONTEXT_1M,
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "claude-haiku-4.5",
		name: "Claude Haiku 4.5",
		thinking: false,
		inputModalities: VISION
	},
	{
		id: "deepseek-3.2",
		name: "DeepSeek 3.2",
		thinking: true,
		inputModalities: VISION
	},
	{
		id: "glm-5",
		name: "GLM-5",
		thinking: true,
		inputModalities: TEXT_ONLY
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5",
		thinking: true,
		inputModalities: TEXT_ONLY
	},
	{
		id: "qwen3-coder-next",
		name: "Qwen3 Coder Next",
		thinking: false,
		inputModalities: VISION
	}
];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	thinking: z.boolean(),
	inputModalities: z.array(z.union(["text", "image"])),
	reasoningEfforts: z.array(z.string()),
	defaultReasoningEffort: z.string(),
	effortSchemaPath: z.union(["output_config", "reasoning"]),
	maxTokensBounds: z.object({
		minimum: z.number().step(1).min(1),
		maximum: z.number().step(1).min(1)
	})
});
const Config = z.object({
	proxyUrl: z.string(),
	region: z.string(),
	profileArn: z.string(),
	thinking: z.union(["enabled", "disabled"]),
	reasoningEffort: z.union([
		"none",
		"off",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	]),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	tokenExpiryBufferMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TOKEN_EXPIRY_BUFFER_MS),
	retryPolicy: RetryPolicySchema
});
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		const reasoningEfforts = model.reasoningEfforts?.length === 0 ? void 0 : model.reasoningEfforts;
		const inputModalities = model.inputModalities?.length === 0 ? void 0 : model.inputModalities;
		if (model.id.length === 0) throw new Error("llm-kiro: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-kiro: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-kiro: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-kiro: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (reasoningEfforts !== void 0 && (reasoningEfforts.some((effort) => effort.length === 0) || new Set(reasoningEfforts).size !== reasoningEfforts.length)) throw new Error(`llm-kiro: catalog model "${model.id}" reasoningEfforts must be unique non-empty ids`);
		if (model.defaultReasoningEffort !== void 0 && !reasoningEfforts?.includes(model.defaultReasoningEffort)) throw new Error(`llm-kiro: catalog model "${model.id}" default reasoning effort is not advertised`);
		if (model.effortSchemaPath === void 0 !== (reasoningEfforts === void 0)) throw new Error(`llm-kiro: catalog model "${model.id}" needs both reasoningEfforts and effortSchemaPath`);
		const bounds = model.maxTokensBounds;
		const maxTokensBounds = bounds === void 0 || bounds.minimum === void 0 || bounds.maximum === void 0 ? void 0 : bounds;
		if (maxTokensBounds !== void 0 && (!Number.isInteger(maxTokensBounds.minimum) || !Number.isInteger(maxTokensBounds.maximum) || maxTokensBounds.minimum < 1 || maxTokensBounds.maximum < maxTokensBounds.minimum)) throw new Error(`llm-kiro: catalog model "${model.id}" maxTokensBounds must be ordered positive integers`);
		if (maxTokensBounds !== void 0 && model.effortSchemaPath === void 0) throw new Error(`llm-kiro: catalog model "${model.id}" maxTokensBounds requires the live request-field schema`);
		if (seen.has(model.id)) throw new Error(`llm-kiro: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.thinking === void 0 ? {} : { thinking: model.thinking },
			...inputModalities === void 0 ? {} : { inputModalities: [...inputModalities] },
			...reasoningEfforts === void 0 ? {} : { reasoningEfforts: [...reasoningEfforts] },
			...model.defaultReasoningEffort === void 0 ? {} : { defaultReasoningEffort: model.defaultReasoningEffort },
			...model.effortSchemaPath === void 0 ? {} : { effortSchemaPath: model.effortSchemaPath },
			...maxTokensBounds === void 0 ? {} : { maxTokensBounds: { ...maxTokensBounds } }
		};
	});
}
/**
* The one explicit resolve step from raw config to validated connection facts.
* Programmatic construction may bypass Schemastery normalization, so every
* default and bound is re-judged here — for the composition entry at load
* (fail loud) and for each settings snapshot at its first use.
* @param config - raw plugin config or resolved settings snapshot.
* @returns validated connection facts.
* @throws when a field is present but unusable (a malformed proxy URL, a
*   duplicate catalog id, an out-of-range timeout).
*/
function resolveAdapterOptions(config) {
	if (config.thinking === "disabled" && config.reasoningEffort !== void 0 && config.reasoningEffort !== "off" && config.reasoningEffort !== "none") throw new Error("llm-kiro: only reasoningEffort \"off\" or \"none\" can be configured when thinking is disabled");
	if (config.proxyUrl !== void 0) parseProxyUrl(config.proxyUrl);
	const region = config.region === void 0 ? void 0 : assertKiroRegion(config.region);
	const profileArn = config.profileArn === void 0 ? void 0 : assertKiroProfileArn(config.profileArn);
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("llm-kiro: defaultContextWindow must be a positive integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-kiro: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const tokenExpiryBufferMs = config.tokenExpiryBufferMs ?? DEFAULT_TOKEN_EXPIRY_BUFFER_MS;
	if (!Number.isFinite(tokenExpiryBufferMs) || tokenExpiryBufferMs < 0 || tokenExpiryBufferMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-kiro: tokenExpiryBufferMs must be a non-negative finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		...config.proxyUrl === void 0 ? {} : { proxyUrl: config.proxyUrl },
		...region === void 0 ? {} : { region },
		...profileArn === void 0 ? {} : { profileArn },
		defaults: {
			thinking: config.thinking,
			...config.thinking === "disabled" ? { reasoningEffort: config.reasoningEffort ?? "off" } : config.reasoningEffort === void 0 ? {} : { reasoningEffort: config.reasoningEffort }
		},
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		tokenExpiryBufferMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-kiro: retryPolicy")
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-kiro: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const managedDirectory = credentialDirectory();
	const tokenResolver = (connection, signal) => resolveTokenFromDirectories([managedDirectory, kiroCredentialDirectory()], {
		expiryBufferMs: connection.tokenExpiryBufferMs,
		fetchJson: (url, body) => postJson(url, body, connection.proxyUrl, signal),
		fetchForm: (url, body) => postForm(url, body, connection.proxyUrl, signal),
		...connection.profileArn === void 0 ? { resolveProfileArn: (accessToken, region, authMethod) => discoverKiroProfileArn(connection, {
			accessToken,
			region,
			authMethod,
			expiresAt: Date.now() + 6e4
		}, signal) } : {},
		writableDirectories: [managedDirectory]
	});
	const discovery = new KiroModelDiscovery({ resolveToken: tokenResolver });
	const modelSettings = new FileModelSettingsStore();
	const usage = new KiroUsageService({ resolveToken: tokenResolver });
	const adapter = new KiroAdapter({
		options,
		resolveToken: tokenResolver,
		discoverModels: async (connection, signal) => {
			try {
				const models = await discovery.list(connection, signal);
				await modelSettings.mergeCatalog(models);
				return models;
			} catch (error) {
				ctx.logger.warn("dsh-kiro: live model discovery failed; using the configured catalog");
				ctx.logger.warn(error);
				return connection.models;
			}
		},
		currentModels: (connection) => discovery.current(connection),
		selectModels: (models) => modelSettings.enabledModels(models),
		resolveAttachments: () => {
			const store = ctx.get("attachments");
			return typeof store?.readImageRequest === "function" ? store : void 0;
		}
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Kiro",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration$1 = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration$1.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
	registerWebApi(ctx, {
		managedDirectory,
		options,
		discovery,
		modelSettings,
		usage,
		resolveToken: tokenResolver
	});
}

//#endregion
export { BUILDER_START_URL, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_REGION, DEFAULT_STREAM_IDLE_TIMEOUT_MS, FileModelSettingsStore, KiroAdapter, KiroModelDiscovery, KiroUsageService, apply, assertKiroProfileArn, assertKiroRegion, assertMicrosoftTokenEndpoint, buildModelRequestFields, clearTokenCache, compareKiroModels, credentialDirectory, credentialSummary, deleteDeviceCredentials, discoverKiroProfileArn, getJson, httpErrorCode, importApiKey, importExternalIdp, importRefreshToken, inject, kiroApiEndpoint, kiroAuthMethod, kiroCredentialDirectory, modelPageToken, modelSelection, modelSettingsPath, modelSupportsThinking, name, normalizeExternalIdpCredentials, parseAvailableModels, parseEffortSchema, parseKiroUsage, parseMaxTokensBounds, parseProxyUrl, pollDeviceLogin, pollSocialDeviceLogin, postForm, postJson, postJsonWithHeaders, profileRegion, resolveAdapterOptions, resolveRefreshTokenOrigin, resolveToken, resolveTokenFromDirectories, saveDeviceCredentials, saveManagedCredentials, startDeviceLogin, startSocialDeviceLogin };