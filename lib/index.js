import z from "@deepseek-ai/schemastery";
import { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, RetryPolicySchema, contentHasImage, resolveRetryPolicy, userAgent } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { request as request$1 } from "node:https";
import { connect } from "node:tls";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
	const headers = {};
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
		headers[name$1] = decoder.decode(buffer.subarray(offset, offset + valueLength));
		offset += valueLength;
	}
	return headers;
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
/** Text standing in for an absent turn, so history keeps alternating. */
const CONTINUATION = "[system: conversation continues]";
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
function narrowEffort(effort) {
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
function resolveEffort(options, defaults) {
	if (options.purpose === "session-title") return "off";
	const effort = options.reasoningEffort === void 0 ? defaults.reasoningEffort : narrowEffort(options.reasoningEffort);
	if (defaults.thinking === "disabled" && effort !== void 0 && effort !== "off") throw new LlmError(`Kiro deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
	return effort ?? "off";
}
/**
* Build the system text Kiro sees, including thinking markers.
* @param options - the harness request.
* @param effort - the resolved effort.
* @returns the system text, empty when there is nothing to say.
*/
function systemText(options, effort) {
	const persona = options.system ?? "";
	if (effort === "off") return persona;
	const markers = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGETS[effort]}</max_thinking_length>`;
	return persona.length === 0 ? markers : `${markers}\n${persona}`;
}
/** Join the text blocks of one message. */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content before text flattening can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The Kiro adapter does not support image content.", "UNSUPPORTED_CONTENT");
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
function foldTurns(messages) {
	const turns = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		const text$2 = flattenText(message.content);
		if (message.role === "assistant") {
			const toolUses = toolUsesOf(message);
			const last$1 = turns.at(-1);
			if (last$1?.role === "assistant") {
				last$1.text = [last$1.text, text$2].filter((part) => part.length > 0).join("\n\n");
				last$1.toolUses = [...last$1.toolUses, ...toolUses];
				continue;
			}
			turns.push({
				role: "assistant",
				text: text$2,
				toolUses
			});
			continue;
		}
		const toolResults = toolResultsOf(message);
		const last = turns.at(-1);
		if (last?.role === "user") {
			last.turn.text = [last.turn.text, text$2].filter((part) => part.length > 0).join("\n\n");
			last.turn.toolResults = [...last.turn.toolResults, ...toolResults];
			continue;
		}
		turns.push({
			role: "user",
			turn: {
				text: text$2,
				toolResults
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
		content: turn.text.length > 0 ? turn.text : turn.toolResults.length > 0 ? TOOL_RESULTS_ONLY : CONTINUATION,
		modelId: model,
		origin: ORIGIN,
		...context === void 0 ? {} : { userInputMessageContext: context }
	};
}
/**
* Build the complete wire request.
*
* The final user turn becomes `currentMessage` and carries the tool schemas;
* everything before it becomes alternating history. A conversation whose last
* turn is the assistant's (a resumed session, a compaction boundary) gets a
* continuation user turn so there is something to answer.
* @param options - the harness request.
* @param defaults - adapter-level thinking defaults.
* @param conversationId - identifier for this request's conversation.
* @param profileArn - CodeWhisperer profile the account bills against.
* @returns the request body.
* @throws `LlmError` when the request carries images, an unusable tool name,
*   an unsupported effort, or no messages at all.
*/
function serializeRequest(options, defaults, conversationId, profileArn) {
	if (options.messages.length === 0) throw new LlmError("Kiro requires at least one message", "INVALID_REQUEST");
	const effort = resolveEffort(options, defaults);
	const turns = foldTurns(options.messages);
	if (turns.at(-1)?.role === "assistant") turns.push({
		role: "user",
		turn: {
			text: CONTINUATION,
			toolResults: []
		}
	});
	const current = turns.pop();
	/* v8 ignore next -- a non-empty conversation always folds to at least one turn */
	if (current === void 0 || current.role !== "user") throw new LlmError("Kiro request has no user turn to answer", "INVALID_REQUEST");
	const history = [];
	for (const entry of turns) {
		const expected = history.length % 2 === 0 ? "user" : "assistant";
		if (entry.role !== expected) history.push(expected === "user" ? { userInputMessage: userMessage({
			text: CONTINUATION,
			toolResults: []
		}, options.model) } : { assistantResponseMessage: { content: CONTINUATION } });
		if (entry.role === "user") {
			history.push({ userInputMessage: userMessage(entry.turn, options.model, entry.turn.toolResults.length > 0 ? { toolResults: entry.turn.toolResults } : void 0) });
			continue;
		}
		history.push({ assistantResponseMessage: {
			content: entry.text.length > 0 ? entry.text : CONTINUATION,
			...entry.toolUses.length > 0 ? { toolUses: entry.toolUses } : {}
		} });
	}
	if (history.length % 2 !== 0) history.push({ assistantResponseMessage: { content: CONTINUATION } });
	const issued = new Set(history.flatMap((entry) => "assistantResponseMessage" in entry ? (entry.assistantResponseMessage.toolUses ?? []).map((use) => use.toolUseId) : []));
	const matched = current.turn.toolResults.filter((result) => issued.has(result.toolUseId));
	const text$2 = current.turn.toolResults.filter((result) => !issued.has(result.toolUseId)).reduce((accumulated, result) => `${accumulated}\n\n[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ""}`, current.turn.text);
	const tools = (options.tools ?? []).map((tool) => ({ toolSpecification: {
		name: assertToolName(tool.name),
		description: tool.description,
		inputSchema: { json: tool.parameters }
	} }));
	const system = systemText(options, effort);
	const currentMessage = userMessage({
		text: text$2,
		toolResults: matched
	}, options.model, tools.length > 0 || matched.length > 0 ? {
		...tools.length > 0 ? { tools } : {},
		...matched.length > 0 ? { toolResults: matched } : {}
	} : void 0);
	if (system.length > 0) {
		const first = history.find((entry) => "userInputMessage" in entry);
		if (first === void 0) currentMessage.content = `${system}\n\n${currentMessage.content}`;
		else first.userInputMessage.content = `${system}\n\n${first.userInputMessage.content}`;
	}
	return {
		...profileArn === void 0 ? {} : { profileArn },
		conversationState: {
			chatTriggerType: "MANUAL",
			conversationId,
			currentMessage: { userInputMessage: currentMessage },
			...history.length > 0 ? { history } : {}
		}
	};
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
	const text$2 = Buffer.concat(chunks).toString("utf8");
	try {
		return {
			status: response.status,
			body: JSON.parse(text$2)
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
async function postJsonWithHeaders(url, body, headers, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			...headers
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
async function getJson(url, headers, proxyUrl, signal) {
	return responseJson(await send({
		url,
		method: "GET",
		headers: {
			accept: "application/json",
			...headers
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
		const text$2 = this.buffer;
		this.buffer = "";
		return [{
			channel: this.channel,
			text: text$2
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
	const text$2 = new TextDecoder().decode(frame.payload);
	try {
		return JSON.parse(text$2);
	} catch {
		throw new LlmError(`malformed Kiro event payload: ${text$2.slice(0, 120)}`, "MALFORMED_RESPONSE");
	}
}
/**
* Translate decoded frames into harness chunks.
* @param frames - decoded event-stream frames in arrival order.
* @returns deltas as they arrive, then every `block-end`, then one terminal
*   `finish`. No `usage` chunk is emitted: the operation reports consumed
*   account credits rather than token counts.
* @throws `LlmError` for an in-band service exception frame or a malformed payload.
*/
async function* translate(frames) {
	const router = new TextRouter();
	const order = [];
	const toolBlocks = /* @__PURE__ */ new Map();
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	function* route(runs) {
		for (const run of runs) {
			if (run.channel === "reasoning") {
				if (reasoningBlock === void 0) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += run.text;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: run.text
				};
				continue;
			}
			if (textBlock === void 0) {
				textBlock = open("text");
				yield {
					type: "block-start",
					index: textBlock.index,
					blockType: "text"
				};
			}
			textBlock.text += run.text;
			yield {
				type: "text-delta",
				index: textBlock.index,
				text: run.text
			};
		}
	}
	for await (const frame of frames) {
		const exception = frame.headers[":exception-type"];
		if (exception !== void 0) throw new LlmError(`Kiro service exception ${exception}: ${new TextDecoder().decode(frame.payload).slice(0, 300)}`, exception);
		switch (frame.headers[":event-type"]) {
			case "assistantResponseEvent": {
				const event = parsePayload(frame);
				if (event.content.length > 0) yield* route(router.push(event.content));
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
			default: break;
		}
	}
	yield* route(router.flush());
	for (const block of order) yield {
		type: "block-end",
		index: block.index,
		block: closeBlock(block)
	};
	yield {
		type: "finish",
		reason: toolBlocks.size > 0 ? { kind: "tool-calls" } : order.length > 0 ? { kind: "stop" } : {
			kind: "error",
			failure: {
				message: "Kiro returned a completed response with no content",
				code: EMPTY_RESPONSE_CODE
			}
		}
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
const KIRO_USER_AGENT$1 = "aws-sdk-js/3.738.0 KiroIDE";
const CODEWHISPERER_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const OFF = ReasoningEffortId("off");
const LOW = ReasoningEffortId("low");
const MEDIUM = ReasoningEffortId("medium");
const HIGH = ReasoningEffortId("high");
/** Efforts every thinking-capable Kiro model publishes, in display order. */
const REASONING_EFFORTS = [
	{
		id: OFF,
		name: "Off"
	},
	{
		id: LOW,
		name: "Low"
	},
	{
		id: MEDIUM,
		name: "Medium"
	},
	{
		id: HIGH,
		name: "High"
	}
];
/** The only effort a thinking-disabled deployment publishes. */
const OFF_ONLY_REASONING_EFFORTS = [{
	id: OFF,
	name: "Off"
}];
/** Select the auth-specific upstream surface Kiro accepts. */
function kiroRequestEndpoint(token, region) {
	return token.authMethod === "idc" || token.authMethod === "external_idp" ? `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse` : `https://q.${region}.amazonaws.com/generateAssistantResponse`;
}
/** Add the token discriminator required by API-key and external-IdP auth. */
function kiroTokenTypeHeaders(token) {
	if (token.authMethod === "api_key") return { TokenType: "API_KEY" };
	if (token.authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
/** Describe one catalog entry for selector consumers. */
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: ["text"]
	};
}
/**
* Map a Kiro HTTP status and error body to a stable harness code.
* @param status - status of a non-2xx response.
* @param body - the response body text, when available.
* @returns the normalized harness error code.
*/
function httpErrorCode(status, body) {
	if (status === 401) return "AUTH";
	if (status === 403) return body !== void 0 && body.includes("bearer token") ? "AUTH" : "FORBIDDEN";
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (body !== void 0 && body.includes("INVALID_MODEL_ID")) return "INVALID_MODEL";
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
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
		return (this.config.discoverModels === void 0 ? connection.models : await this.config.discoverModels(connection, AbortSignal.timeout(1e4))).map((model) => modelInfo(provider, model));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = (this.config.currentModels?.(connection) ?? connection.models).find((entry) => entry.id === model);
		const thinking = connection.defaults.thinking !== "disabled" && (configured?.thinking ?? true);
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
				efforts: REASONING_EFFORTS,
				defaultEffort: ReasoningEffortId(connection.defaults.reasoningEffort ?? "off")
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
		const body = JSON.stringify(serializeRequest(options, connection.defaults, randomUUID(), profileArn));
		const response = await post({
			url,
			headers: {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
				authorization: `Bearer ${token.accessToken}`,
				...url.includes("://codewhisperer.") ? { "x-amz-target": CODEWHISPERER_TARGET } : {},
				...kiroTokenTypeHeaders(token),
				"x-amzn-kiro-agent-mode": "vibe",
				"user-agent": KIRO_USER_AGENT$1,
				"x-amz-user-agent": `${KIRO_USER_AGENT$1} ${userAgent()}`
			},
			body,
			signal,
			...connection.proxyUrl === void 0 ? {} : { proxyUrl: connection.proxyUrl }
		});
		if (response.status !== 200) {
			const chunks = [];
			for await (const chunk of response.body) chunks.push(chunk);
			const text$2 = Buffer.concat(chunks).toString("utf8");
			let message = `Kiro API error (HTTP ${response.status})`;
			try {
				const parsed = JSON.parse(text$2);
				if (parsed.message !== void 0) message = parsed.message;
			} catch {}
			const id = response.headers["x-amzn-requestid"];
			throw new LlmError(message, httpErrorCode(response.status, text$2), {
				status: response.status,
				...typeof id === "string" && id.length > 0 ? { requestId: ProviderRequestId(id) } : {}
			});
		}
		yield* translate(decodeFrames(response.body, onActivity));
	}
};

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
//#region lib/types/external-idp.js
const MICROSOFT_TOKEN_HOSTS = new Set([
	"login.microsoftonline.com",
	"login.microsoft.com",
	"login.windows.net"
]);
function record$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function scopes(value) {
	if (Array.isArray(value)) {
		const result = value.map(text$1).filter((item) => item !== void 0).join(" ");
		return result.length > 0 ? result : void 0;
	}
	return text$1(value);
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
		const expiry = record$3(JSON.parse(Buffer.from(part, "base64url").toString("utf8")))?.exp;
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
	const value = record$3(parsed);
	if (value === void 0) throw new Error("dsh-kiro: external IdP credential JSON is required");
	const method = text$1(value.authMethod ?? value.auth_method);
	if (method !== void 0 && method !== "external_idp") throw new Error("dsh-kiro: imported credential is not external_idp auth");
	const accessToken = text$1(value.accessToken ?? value.access_token);
	const refreshToken = text$1(value.refreshToken ?? value.refresh_token);
	const clientId = text$1(value.clientId ?? value.client_id);
	const tokenEndpoint = text$1(value.tokenEndpoint ?? value.token_endpoint);
	const profileArn = text$1(value.profileArn ?? value.profile_arn);
	const scope = scopes(value.scope ?? value.scopes);
	if (accessToken === void 0) throw new Error("dsh-kiro: external IdP access_token is required");
	if (refreshToken === void 0) throw new Error("dsh-kiro: external IdP refresh_token is required");
	if (clientId === void 0) throw new Error("dsh-kiro: external IdP client_id is required");
	if (tokenEndpoint === void 0) throw new Error("dsh-kiro: external IdP token_endpoint is required");
	if (profileArn === void 0) throw new Error("dsh-kiro: external IdP profile_arn is required");
	if (scope === void 0) throw new Error("dsh-kiro: external IdP scopes are required");
	const explicitExpiry = text$1(value.expiresAt ?? value.expires_at ?? value.expired);
	const expiresIn = Number(value.expiresIn ?? value.expires_in);
	return {
		accessToken,
		refreshToken,
		expiresAt: explicitExpiry !== void 0 && Number.isFinite(Date.parse(explicitExpiry)) ? new Date(explicitExpiry).toISOString() : Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1e3).toISOString() : jwtExpiry(accessToken) ?? new Date(Date.now() + 36e5).toISOString(),
		region: assertKiroRegion(text$1(value.region) ?? "us-east-1"),
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
/** Directory holding Kiro IDE/CLI's shared SSO cache. */
function kiroCredentialDirectory() {
	return join(homedir(), ...SSO_CACHE_DIR);
}
function record$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function numeric(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function inferAuthMethod(value, source) {
	if (value === "builder-id" || value === "idc" || value === "google" || value === "github" || value === "imported" || value === "api_key" || value === "external_idp") return value;
	if (source.tokenEndpoint !== void 0 || source.token_endpoint !== void 0) return "external_idp";
	if (source.tokenType === "API_KEY" || source.token_type === "API_KEY") return "api_key";
	const configuredStartUrl = text(source.startUrl ?? source.start_url);
	if (source.clientIdHash !== void 0 || source.client_id_hash !== void 0) return configuredStartUrl === void 0 || configuredStartUrl === "https://view.awsapps.com/start" ? "builder-id" : "idc";
	if (configuredStartUrl !== void 0 && configuredStartUrl !== "https://view.awsapps.com/start") return "idc";
	return "builder-id";
}
function normalizeTokenFile(value) {
	const source = record$2(value);
	if (source === void 0) throw new LlmError("Kiro token file is not a JSON object", "INVALID_CREDENTIAL");
	const accessToken = text(source.accessToken ?? source.access_token);
	const refreshToken = text(source.refreshToken ?? source.refresh_token);
	const expiresAt = text(source.expiresAt ?? source.expires_at ?? source.expired);
	const clientIdHash = text(source.clientIdHash ?? source.client_id_hash);
	const clientId = text(source.clientId ?? source.client_id);
	const tokenEndpoint = text(source.tokenEndpoint ?? source.token_endpoint);
	const scope = Array.isArray(source.scopes) ? source.scopes.map(text).filter((item) => item !== void 0).join(" ") : text(source.scope ?? source.scopes);
	const region = text(source.region);
	const profileArn = text(source.profileArn ?? source.profile_arn);
	const startUrl$1 = text(source.startUrl ?? source.start_url);
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
	const value = record$2(body);
	return text(value?.error_description ?? value?.errorDescription ?? value?.message ?? value?.error) ?? `HTTP ${status}`;
}
function parseRefresh(body, fallbackRefreshToken) {
	const value = record$2(body);
	const accessToken = text(value?.accessToken ?? value?.access_token);
	if (accessToken === void 0) throw new LlmError("Kiro token refresh returned no access token", "AUTH");
	const lifetime = Math.max(1, numeric(value?.expiresIn ?? value?.expires_in) ?? 3600);
	const rawProfile = text(value?.profileArn ?? value?.profile_arn);
	return {
		accessToken,
		refreshToken: text(value?.refreshToken ?? value?.refresh_token) ?? fallbackRefreshToken,
		expiresAt: Date.now() + lifetime * 1e3,
		...rawProfile === void 0 ? {} : { profileArn: assertKiroProfileArn(rawProfile) }
	};
}
async function registration(directory, hash) {
	const value = record$2(await readJsonFile(join(directory, `${hash}.json`), "device registration"));
	const clientId = text(value?.clientId ?? value?.client_id);
	const clientSecret = text(value?.clientSecret ?? value?.client_secret);
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
	} else if (token.authMethod === "imported" || token.authMethod === "google" || token.authMethod === "github") response = await options.fetchJson(SOCIAL_REFRESH_URL, { refreshToken });
	else throw new LlmError("Kiro credential cannot be refreshed without its client registration", "INVALID_CREDENTIAL");
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
const DEFAULT_CACHE_TTL_MS = 300 * 1e3;
const KIRO_USER_AGENT = "aws-sdk-js/3.738.0 KiroIDE";
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function tokenTypeHeaders(authMethod) {
	if (authMethod === "api_key") return { TokenType: "API_KEY" };
	if (authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
function authHeaders(token) {
	return {
		authorization: `Bearer ${token.accessToken}`,
		"user-agent": KIRO_USER_AGENT,
		"x-amz-user-agent": KIRO_USER_AGENT,
		"x-amzn-codewhisperer-optout": "true",
		...tokenTypeHeaders(token.authMethod)
	};
}
/** Resolve the best CodeWhisperer profile ARN for one OAuth credential. */
async function discoverKiroProfileArn(connection, token, signal, request$2 = postJsonWithHeaders) {
	if (token.authMethod === "api_key") return void 0;
	const candidates = [...new Set([
		connection.region,
		token.region,
		"us-east-1",
		"eu-central-1"
	].filter((candidate) => candidate !== void 0))];
	for (const candidate of candidates) {
		const endpoint = `https://codewhisperer.${candidate}.amazonaws.com`;
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
			const response = await request$2(attempt.url, { maxResults: 50 }, attempt.headers, connection.proxyUrl, signal);
			if (response.status !== 200) continue;
			const profiles = record$1(response.body)?.profiles;
			if (!Array.isArray(profiles)) continue;
			const valid = [];
			for (const raw of profiles) {
				const value = record$1(raw);
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
/**
* Parse Kiro's ListAvailableModels response into harness catalog entries.
* @param body - decoded JSON response.
* @returns unique models in provider order.
*/
function parseAvailableModels(body) {
	const rawModels = record$1(body)?.models;
	if (!Array.isArray(rawModels)) throw new Error("Kiro ListAvailableModels returned no models array");
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const raw of rawModels) {
		const model = record$1(raw);
		if (model === void 0 || typeof model.modelId !== "string" || model.modelId.length === 0) continue;
		if (seen.has(model.modelId)) continue;
		seen.add(model.modelId);
		const limits = record$1(model.tokenLimits);
		const contextWindow = positiveInteger(limits?.maxInputTokens);
		const maxTokens = positiveInteger(limits?.maxOutputTokens);
		models.push({
			id: model.modelId,
			...typeof model.modelName === "string" && model.modelName.length > 0 ? { name: model.modelName } : {},
			...typeof model.description === "string" && model.description.length > 0 ? { description: model.description } : {},
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			thinking: modelSupportsThinking(model.modelId)
		});
	}
	if (models.length === 0) throw new Error("Kiro ListAvailableModels returned no usable model ids");
	return models;
}
function discoveryError(status, body) {
	const value = record$1(body);
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
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	}
	key(connection, region) {
		return `${region}\u0000${connection.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`;
	}
	/** Drop all cached discovery results after login or logout. */
	clear() {
		this.cache.clear();
	}
	endpoint(region) {
		return region === "us-east-1" ? "https://codewhisperer.us-east-1.amazonaws.com" : `https://q.${region}.amazonaws.com`;
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
		url.searchParams.set("maxResults", "50");
		if (profileArn !== void 0) url.searchParams.set("profileArn", profileArn);
		const response = await this.requestJson(url.toString(), this.headers(token), connection.proxyUrl, signal);
		if (response.status !== 200) throw discoveryError(response.status, response.body);
		const models = parseAvailableModels(response.body);
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
//#region lib/types/login.js
const TOKEN_FILE = "kiro-auth-token.json";
const BUILDER_START_URL = "https://view.awsapps.com/start";
const KIRO_ISSUER_URL = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";
const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations"
];
const SOCIAL_REDIRECT = "kiro://kiro.kiroAgent/authenticate-success";
function record(value) {
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
	const value = record(body);
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
* Begin an AWS Builder ID or IAM Identity Center device authorization.
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
	const registered = record(registration$1.body);
	const clientId = registered === void 0 ? void 0 : stringField(registered, "clientId", "client_id");
	const clientSecret = registered === void 0 ? void 0 : stringField(registered, "clientSecret", "client_secret");
	if (clientId === void 0 || clientSecret === void 0) throw new Error("Kiro client registration returned no client id or secret");
	const authorization = await requestJson(`${oidcBase}/device_authorization`, {
		clientId,
		clientSecret,
		startUrl: selectedStartUrl
	}, signal);
	if (authorization.status !== 200) throw new Error(`Kiro device authorization failed: ${providerError(authorization.body, `HTTP ${authorization.status}`)}`);
	const authorized = record(authorization.body);
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
	const body = record(response.body);
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
/** Start Kiro desktop social OAuth with PKCE and a manual kiro:// callback. */
function startSocialLogin(provider) {
	const codeVerifier = randomBytes(32).toString("base64url");
	const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
	const state = randomBytes(24).toString("base64url");
	const idp = provider === "google" ? "Google" : "Github";
	const url = new URL(`${KIRO_AUTH_SERVICE}/login`);
	url.searchParams.set("idp", idp);
	url.searchParams.set("redirect_uri", SOCIAL_REDIRECT);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("prompt", "select_account");
	return {
		provider,
		state,
		codeVerifier,
		authUrl: url.toString(),
		expiresAt: Date.now() + 6e5
	};
}
/** Complete Google/GitHub auth from the callback URL Kiro redirected to. */
async function completeSocialLogin(callbackUrl, session, requestJson, signal) {
	if (Date.now() >= session.expiresAt) throw new Error("Kiro social login expired; start again");
	let callback;
	try {
		callback = new URL(callbackUrl.trim());
	} catch (error) {
		throw new Error("Kiro social callback URL is invalid", { cause: error });
	}
	if (callback.protocol !== "kiro:" || callback.hostname.toLowerCase() !== "kiro.kiroagent" || callback.pathname !== "/authenticate-success") throw new Error("Kiro social callback URL has an unexpected destination");
	if (callback.searchParams.get("state") !== session.state) throw new Error("Kiro social callback state does not match");
	const callbackError = callback.searchParams.get("error_description") ?? callback.searchParams.get("error");
	if (callbackError !== null) throw new Error(`Kiro social login failed: ${callbackError}`);
	const code = callback.searchParams.get("code");
	if (code === null || code.length === 0) throw new Error("Kiro social callback contains no authorization code");
	const response = await requestJson(`${KIRO_AUTH_SERVICE}/oauth/token`, {
		code,
		code_verifier: session.codeVerifier,
		redirect_uri: SOCIAL_REDIRECT
	}, signal);
	if (response.status !== 200) throw new Error(`Kiro social token exchange failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const body = record(response.body);
	const accessToken = body === void 0 ? void 0 : stringField(body, "accessToken", "access_token");
	const refreshToken = body === void 0 ? void 0 : stringField(body, "refreshToken", "refresh_token");
	if (accessToken === void 0 || refreshToken === void 0) throw new Error("Kiro social token exchange returned incomplete credentials");
	const expiresIn = Math.max(1, body === void 0 ? 3600 : numberField(body, "expiresIn", "expires_in") ?? 3600);
	const profileArn = body === void 0 ? void 0 : stringField(body, "profileArn", "profile_arn");
	return {
		accessToken,
		refreshToken,
		expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
		region: "us-east-1",
		authMethod: session.provider,
		...profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(profileArn) }
	};
}
/** Validate and refresh an imported Kiro refresh token. */
async function importRefreshToken(input, requestJson, signal) {
	const refreshToken = input.refreshToken.trim();
	if (refreshToken.length === 0) throw new Error("Kiro refresh token is required");
	if (input.clientId === void 0 !== (input.clientSecret === void 0)) throw new Error("Kiro client id and client secret must be provided together");
	const region = assertKiroRegion(input.region?.trim() || "us-east-1");
	const isIdc = input.clientId !== void 0 && input.clientSecret !== void 0;
	const response = await requestJson(isIdc ? `https://oidc.${region}.amazonaws.com/token` : `${KIRO_AUTH_SERVICE}/refreshToken`, isIdc ? {
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		refreshToken,
		grantType: "refresh_token"
	} : { refreshToken }, signal);
	if (response.status !== 200) throw new Error(`Kiro refresh-token import failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const body = record(response.body);
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
		authMethod: isIdc ? "idc" : "imported",
		...isIdc ? {
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			...input.startUrl === void 0 ? {} : { startUrl: startUrl(input.startUrl) }
		} : {},
		...selectedProfile === void 0 ? {} : { profileArn: assertKiroProfileArn(selectedProfile) }
	};
}
/** Validate a long-lived Kiro API key against its actual model catalog. */
async function importApiKey(apiKey, regionValue, requestGet, signal) {
	const accessToken = apiKey.trim();
	if (accessToken.length === 0) throw new Error("Kiro API key is required");
	const region = assertKiroRegion(regionValue?.trim() || "us-east-1");
	const url = new URL(`https://q.${region}.amazonaws.com/ListAvailableModels`);
	url.searchParams.set("origin", "AI_EDITOR");
	const response = await requestGet(url.toString(), {
		authorization: `Bearer ${accessToken}`,
		TokenType: "API_KEY",
		"user-agent": "aws-sdk-js/3.738.0 KiroIDE",
		"x-amz-user-agent": "aws-sdk-js/3.738.0 KiroIDE"
	}, signal);
	const models = record(response.body)?.models;
	if (response.status !== 200 || !Array.isArray(models) || models.length === 0) throw new Error("Kiro API key validation failed");
	return {
		accessToken,
		expiresAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1e3).toISOString(),
		region,
		authMethod: "api_key"
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
	const value = record(parsed);
	if (value === void 0) return { authenticated: false };
	const accessToken = stringField(value, "accessToken", "access_token");
	const refreshToken = stringField(value, "refreshToken", "refresh_token");
	const expiresAt = stringField(value, "expiresAt", "expires_at");
	const region = stringField(value, "region");
	const method = stringField(value, "authMethod", "auth_method");
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
		const parsed = record(JSON.parse(await readFile(join(directory, TOKEN_FILE), "utf8")));
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
		...flow.kind === "social" && flow.status === "pending" ? { needsCallback: true } : {},
		...flow.error === void 0 ? {} : { error: flow.error }
	};
}
function modelPayload(models, source) {
	return {
		source,
		fetchedAt: Date.now(),
		models: models.map((model) => ({
			id: model.id,
			name: model.name ?? model.id,
			description: model.description,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			thinking: model.thinking ?? true,
			reasoningEfforts: model.thinking === false ? ["off"] : [
				"off",
				"low",
				"medium",
				"high"
			]
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
			models: modelPayload(cached$1 ?? connection.models, cached$1 === void 0 ? "configured" : "live")
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
			deviceSession: session,
			authUrl: session.verificationUri,
			userCode: session.userCode,
			startedAt: Date.now()
		};
		login = flow;
		(async () => {
			let intervalSeconds = session.intervalSeconds;
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
					const result = await pollDeviceLogin(session, requestJson, controller.signal);
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
		return publicLogin(login);
	};
	const beginSocial = (method) => {
		loginController?.abort("starting a new Kiro social login");
		loginController = new AbortController();
		const session = startSocialLogin(method);
		login = {
			status: "pending",
			kind: "social",
			method,
			socialSession: session,
			authUrl: session.authUrl,
			startedAt: Date.now()
		};
		return publicLogin(login);
	};
	const completeSocial = async (body) => {
		const flow = login;
		const session = flow?.socialSession;
		const controller = loginController;
		if (flow?.kind !== "social" || flow.status !== "pending" || session === void 0 || controller === void 0) throw new Error("No Kiro social login is waiting for a callback");
		const connection = dependencies.options();
		await finish(await completeSocialLogin(requiredText(body.callbackUrl, "Kiro callback URL"), session, (url, value, signal) => postJson(url, value, connection.proxyUrl, signal), controller.signal), flow, controller.signal);
		return publicLogin(login);
	};
	const importCredential = async (body) => {
		loginController?.abort("importing Kiro credentials");
		loginController = void 0;
		const connection = dependencies.options();
		const signal = AbortSignal.timeout(3e4);
		const method = requiredText(body.method, "Kiro import method");
		let credentials;
		if (method === "refresh-token") {
			const region = optionalText(body.region) ?? connection.region;
			const profileArn = optionalText(body.profileArn);
			const clientId = optionalText(body.clientId);
			const clientSecret = optionalText(body.clientSecret);
			const startUrl$1 = optionalText(body.startUrl);
			credentials = await importRefreshToken({
				refreshToken: requiredText(body.refreshToken, "Kiro refresh token"),
				...region === void 0 ? {} : { region },
				...profileArn === void 0 ? {} : { profileArn },
				...clientId === void 0 ? {} : { clientId },
				...clientSecret === void 0 ? {} : { clientSecret },
				...startUrl$1 === void 0 ? {} : { startUrl: startUrl$1 }
			}, (url, value, requestSignal) => postJson(url, value, connection.proxyUrl, requestSignal), signal);
		} else if (method === "api-key") credentials = await importApiKey(requiredText(body.apiKey, "Kiro API key"), optionalText(body.region) ?? connection.region, (url, headers, requestSignal) => getJson(url, headers, connection.proxyUrl, requestSignal), signal);
		else if (method === "external-idp") credentials = importExternalIdp(body.credentials);
		else throw new Error("Unsupported Kiro import method");
		await save(credentials, signal);
		login = void 0;
		return status();
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
								value: method === "google" || method === "github" ? beginSocial(method) : await beginDevice({
									...body,
									method
								})
							});
							return;
						}
						if (path === "login/social/complete" && request$2.method === "POST") {
							sendJson(response, 200, {
								ok: true,
								value: await completeSocial(await readJson(request$2))
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
								value: modelPayload(cached$1 ?? connection.models, cached$1 === void 0 ? "configured" : "live")
							});
							return;
						}
						if (path === "models/refresh" && request$2.method === "POST") {
							const connection = dependencies.options();
							const models = await dependencies.discovery.list(connection, AbortSignal.timeout(15e3), true);
							emitUpdated();
							sendJson(response, 200, {
								ok: true,
								value: modelPayload(models, "live")
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
const DEFAULT_MODELS = [
	{
		id: "auto",
		name: "Auto",
		thinking: false
	},
	{
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		thinking: false
	},
	{
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4.5",
		thinking: true
	},
	{
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-sonnet-4.6-1m",
		name: "Claude Sonnet 4.6 (1M)",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-opus-4.5",
		name: "Claude Opus 4.5",
		thinking: true
	},
	{
		id: "claude-opus-4.6",
		name: "Claude Opus 4.6",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-opus-4.6-1m",
		name: "Claude Opus 4.6 (1M)",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-opus-4.7",
		name: "Claude Opus 4.7",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-haiku-4.5",
		name: "Claude Haiku 4.5",
		thinking: false
	},
	{
		id: "deepseek-3.2",
		name: "DeepSeek 3.2",
		thinking: true
	},
	{
		id: "glm-5",
		name: "GLM-5",
		thinking: true
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5",
		thinking: true
	},
	{
		id: "qwen3-coder-next",
		name: "Qwen3 Coder Next",
		thinking: false
	}
];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	thinking: z.boolean()
});
const Config = z.object({
	proxyUrl: z.string(),
	region: z.string(),
	profileArn: z.string(),
	thinking: z.union(["enabled", "disabled"]),
	reasoningEffort: z.union([
		"off",
		"low",
		"medium",
		"high"
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
		if (model.id.length === 0) throw new Error("llm-kiro: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-kiro: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-kiro: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-kiro: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`llm-kiro: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.thinking === void 0 ? {} : { thinking: model.thinking }
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
	if (config.thinking === "disabled" && config.reasoningEffort !== void 0 && config.reasoningEffort !== "off") throw new Error("llm-kiro: only reasoningEffort \"off\" can be configured when thinking is disabled");
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
			reasoningEffort: config.reasoningEffort
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
	const adapter = new KiroAdapter({
		options,
		resolveToken: tokenResolver,
		discoverModels: async (connection, signal) => {
			try {
				return await discovery.list(connection, signal);
			} catch (error) {
				ctx.logger.warn("dsh-kiro: live model discovery failed; using the configured catalog");
				ctx.logger.warn(error);
				return connection.models;
			}
		},
		currentModels: (connection) => discovery.current(connection)
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
		resolveToken: tokenResolver
	});
}

//#endregion
export { BUILDER_START_URL, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_REGION, DEFAULT_STREAM_IDLE_TIMEOUT_MS, KiroAdapter, KiroModelDiscovery, apply, assertKiroProfileArn, assertKiroRegion, assertMicrosoftTokenEndpoint, clearTokenCache, completeSocialLogin, credentialDirectory, credentialSummary, deleteDeviceCredentials, discoverKiroProfileArn, getJson, httpErrorCode, importApiKey, importExternalIdp, importRefreshToken, inject, kiroCredentialDirectory, modelSupportsThinking, name, normalizeExternalIdpCredentials, parseAvailableModels, parseProxyUrl, pollDeviceLogin, postForm, postJson, postJsonWithHeaders, profileRegion, resolveAdapterOptions, resolveToken, resolveTokenFromDirectories, saveDeviceCredentials, saveManagedCredentials, startDeviceLogin, startSocialLogin };