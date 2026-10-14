import { createHash, randomUUID } from 'node:crypto';
// Chat Completions (what CodeBuddy sends) <-> OpenAI Responses (what we call for OpenAI models), and a cleaned
// Chat Completions request for OpenRouter models (ids of the form maker/model). Pure functions.
// CodeBuddy stays the agent loop; this layer only reshapes one model call at a time.

type Part = { type: string; text?: string; refusal?: string; image_url?: { url: string } | string };
export type ChatToolCall = { id: string; type?: 'function'; function: { name: string; arguments: string } };
export type ChatMessage = { role: string; content?: string | Part[] | null; tool_calls?: ChatToolCall[]; tool_call_id?: string };
export type ChatRequest = {
  model: string; messages: ChatMessage[]; stream?: boolean; tools?: { type: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  tool_choice?: unknown; parallel_tool_calls?: boolean; reasoning_effort?: string; max_tokens?: number; max_completion_tokens?: number;
  response_format?: { type?: string; json_schema?: { name?: string; schema?: Record<string, unknown>; strict?: boolean; description?: string } };
};
export type ResponsesItem = Record<string, any> & { type: string };
export type ResponsesResult = {
  id: string; status?: string; incomplete_details?: { reason?: string } | null; output: ResponsesItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
};
export class GatewayError extends Error { constructor(readonly status: number, message: string, readonly code = 'invalid_request') { super(message); } }

export const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
// The answer format (7 October 2026, for the photo reader): Chat Completions' response_format as the Responses text format. A JSON object,
// or a named JSON schema. Plain text, and anything else, is dropped as before, so a harness that sends some other value is never refused.
export function responsesFormat(format: ChatRequest['response_format']) {
  if (!format || typeof format !== 'object') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  const spec = format.json_schema;
  if (format.type === 'json_schema' && spec?.name && spec.schema && typeof spec.schema === 'object') return { type: 'json_schema', name: spec.name, schema: spec.schema, ...(typeof spec.strict === 'boolean' ? { strict: spec.strict } : {}), ...(spec.description ? { description: spec.description } : {}) };
  return undefined;
}

const text = (content: ChatMessage['content'], role: string): string => {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map(part => {
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text ?? '';
    if (part.type === 'refusal') return part.refusal ?? '';
    throw new GatewayError(400, `Unsupported ${role} content part: ${String(part.type).slice(0, 40)}`);
  }).join('');
};
// Images reach the provider inline only. Given a link, the provider fetches it, so a crafted address could carry data
// out. The photo reader already sends data: URLs.
const inlineImage = (part: Part) => {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
    throw new GatewayError(400, 'Images must be sent inline as data:image/...;base64; image links are not forwarded');
  }
  return url;
};
const userContent = (content: ChatMessage['content']) => {
  if (content == null || typeof content === 'string') return content ?? '';
  return content.map(part => part.type === 'image_url'
    ? { type: 'input_image', image_url: inlineImage(part) }
    : { type: 'input_text', text: text([part], 'user') });
};
// OpenAI rejects some JSON Schema bookkeeping keys in function parameters; the shape itself is kept.
const cleanSchema = (schema: Record<string, unknown> | undefined) => { const { $schema: _drop, ...rest } = schema ?? { type: 'object', properties: {} }; return rest; };
const toolChoice = (choice: unknown) => {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  const name = (choice as { function?: { name?: string } } | undefined)?.function?.name;
  return name ? { type: 'function', name } : undefined;
};

const sameCalls = (replay: ResponsesItem[], calls: ChatToolCall[]) => {
  const stored = replay.filter(item => item.type === 'function_call').map(item => item.call_id).sort();
  return stored.length === calls.length && calls.map(call => call.id).sort().every((id, i) => id === stored[i]);
};

// `replayFor` returns the model's own output items (encrypted reasoning, text and tool calls, in their
// original order) for a turn that ended in tool calls, so a reasoning model keeps its chain across
// turns even though CodeBuddy's chat history has no place for reasoning. Used only when the turn's
// tool calls match exactly; otherwise the turn is rebuilt from the chat message without reasoning.
export function chatToResponses(body: ChatRequest, upstreamModel: string, replayFor: (callId: string) => ResponsesItem[] | undefined = () => undefined, cacheKey?: string) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new GatewayError(400, 'messages must be a non-empty array');
  const input: ResponsesItem[] = [];
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') input.push({ type: 'message', role: 'developer', content: text(message.content, 'system') });
    else if (message.role === 'user') input.push({ type: 'message', role: 'user', content: userContent(message.content) });
    else if (message.role === 'assistant') {
      const calls = message.tool_calls ?? [];
      const replay = calls.length ? replayFor(calls[0].id) : undefined;
      if (replay && sameCalls(replay, calls)) { input.push(...replay); continue; }
      const said = text(message.content, 'assistant');
      if (said) input.push({ type: 'message', role: 'assistant', content: said });
      for (const call of calls) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments ?? '{}' });
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new GatewayError(400, 'tool message without tool_call_id');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: text(message.content, 'tool') });
    } else throw new GatewayError(400, `Unsupported message role: ${String(message.role).slice(0, 40)}`);
  }
  const tools = (body.tools ?? []).filter(tool => tool.type === 'function' && tool.function?.name)
    .map(tool => ({ type: 'function', name: tool.function!.name, description: tool.function!.description ?? '', parameters: cleanSchema(tool.function!.parameters), strict: false }));
  const maxOutput = body.max_completion_tokens ?? body.max_tokens;
  const choice = toolChoice(body.tool_choice), format = responsesFormat(body.response_format);
  // Dropped on purpose: temperature (reasoning models reject it), verbosity, reasoning_summary and
  // max_thinking_tokens (effort is the Responses control), and CodeBuddy's per-message bookkeeping fields.
  return {
    model: upstreamModel, input, store: false, include: ['reasoning.encrypted_content'],
    ...(tools.length ? { tools } : {}), ...(choice ? { tool_choice: choice } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean' ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.reasoning_effort && EFFORTS.has(body.reasoning_effort) ? { reasoning: { effort: body.reasoning_effort } } : {}),
    ...(Number.isInteger(maxOutput) && maxOutput! > 0 ? { max_output_tokens: maxOutput } : {}),
    ...(format ? { text: { format } } : {}),
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
  };
}

export function responsesToChat(result: ResponsesResult, model: string, created = Math.floor(Date.now() / 1000)) {
  if (result.status === 'failed') throw new GatewayError(502, 'Upstream response failed', 'upstream_failed');
  // A cut-off response (output budget or content filter) may hold truncated tool arguments: report the
  // truncation and pass on no tool call, so nothing half-formed is executed.
  const incomplete = result.status === 'incomplete';
  let content = '';
  const toolCalls: ChatToolCall[] = [], replay: ResponsesItem[] = [];
  for (const item of result.output ?? []) {
    if (item.type === 'message') {
      const said = (item.content ?? []).map((part: Part) => part.type === 'output_text' ? part.text ?? '' : part.type === 'refusal' ? part.refusal ?? '' : '').join('');
      content += said;
      if (said) replay.push({ type: 'message', role: 'assistant', content: said });
    } else if (item.type === 'function_call' && !incomplete) {
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } });
      replay.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' });
    } else if (item.type === 'reasoning' && item.encrypted_content) replay.push({ type: 'reasoning', id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content });
  }
  const reason = result.incomplete_details?.reason;
  const finish = incomplete ? (reason === 'content_filter' ? 'content_filter' : 'length') : toolCalls.length ? 'tool_calls' : 'stop';
  const u = result.usage ?? {};
  const usage = {
    prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 }, completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 },
  };
  const completion = {
    id: 'chatcmpl-' + result.id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage,
  };
  // Worth keeping only when the turn ends in tool calls and carries reasoning to hand back.
  const keep = toolCalls.length && replay.some(item => item.type === 'reasoning');
  return { completion, replay: keep ? replay : [], callIds: toolCalls.map(call => call.id) };
}

// The same completion as a Chat Completions event stream: role and text, one chunk per tool call
// (arguments whole, never fragmented), the finish reason, then usage, then [DONE].
export function completionToSse(completion: ReturnType<typeof responsesToChat>['completion']): string[] {
  const { id, created, model } = completion, choice = completion.choices[0];
  const chunk = (choices: unknown[], extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`;
  const out = [chunk([{ index: 0, delta: { role: 'assistant', content: choice.message.content ?? '' }, finish_reason: null }])];
  (choice.message.tool_calls ?? []).forEach((call, index) => out.push(chunk([{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: call.function }] }, finish_reason: null }])));
  out.push(chunk([{ index: 0, delta: {}, finish_reason: choice.finish_reason }]));
  out.push(chunk([], { usage: completion.usage }));
  out.push('data: [DONE]\n\n');
  return out;
}

// ---- OpenRouter (1 October 2026): models whose id is maker/model, for example deepseek/deepseek-v4.1-flash.
// OpenRouter speaks Chat Completions, so the request is the harness's own request with its bookkeeping fields
// dropped, never streamed upstream (the gateway keeps the harness's stream alive and sends the whole answer),
// and the answer is normalised to the same completion shape the OpenAI path produces.
export const viaOpenRouter = (model: string) => model.includes('/');
export type OpenRouterResult = {
  id?: string; model?: string; provider?: string; error?: { message?: string; code?: string | number };
  choices?: { message?: { content?: string | Part[] | null; refusal?: string | null; reasoning?: string | null; tool_calls?: Partial<ChatToolCall>[]; reasoning_details?: unknown[] }; finish_reason?: string | null; native_finish_reason?: string | null; error?: { message?: string; code?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
};
const chatUserContent = (content: ChatMessage['content']) => {
  if (content == null || typeof content === 'string') return content ?? '';
  return content.map(part => part.type === 'image_url'
    ? { type: 'image_url', image_url: { url: inlineImage(part) } }
    : { type: 'text', text: text([part], 'user') });
};
/**
 * Where an assistant turn sits in a conversation, as a hash of everything before it plus the turn itself. The gateway
 * stores a turn's reasoning under this key and hands it back when the harness replays the turn: the harness's chat history
 * has no place for reasoning, and DeepSeek's thinking mode can reject a tool conversation whose earlier reasoning is gone.
 * The whole history is hashed, never a tool-call id or a text alone: two sessions can receive the
 * same id, and one conversation can contain the same sentence twice. Two conversations share a key only when every message
 * up to and including the turn is the same. Only meaning is hashed, not representation, because a harness may echo an
 * earlier message in another shape: text is trimmed and a string equals the same text split into parts; tool arguments are
 * parsed and their object keys sorted (values and array order kept), the raw string only when they do not parse; an image
 * is its URL's hash.
 */
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;
// Tagged, so unparseable arguments never equal a JSON value that happens to print the same, and an image never equals text.
// Arguments holding a number JSON.parse cannot represent exactly (16 or more digits, a long fraction, an exponent) are kept
// raw: parsing would round two different values to the same one.
const lossyNumber = /(^|[^\w"])-?\d{16,}|\d\.\d{15,}|\d[eE][+-]?\d/;
const canonArguments = (raw: unknown): unknown => { if (typeof raw !== 'string') return ['json', sorted(raw ?? {})]; if (lossyNumber.test(raw)) return ['raw', raw.trim()]; try { return ['json', sorted(JSON.parse(raw || '{}'))]; } catch { return ['raw', raw]; } };
const canonContent = (content: ChatMessage['content']): unknown => {
  const segments: [string, string][] = [];
  const say = (value: string) => { const last = segments.at(-1); if (last?.[0] === 'text') last[1] += value; else segments.push(['text', value]); };
  if (typeof content === 'string') say(content);
  else for (const part of content ?? []) {
    if (part.type === 'image_url') segments.push(['image', createHash('sha256').update(String(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? '')).digest('hex').slice(0, 32)]);
    else say(part.text ?? part.refusal ?? '');
  }
  return segments.map(([kind, value]) => [kind, kind === 'text' ? value.trim() : value]).filter(([kind, value]) => kind !== 'text' || value);
};
const canon = (message: ChatMessage): unknown => message.role === 'assistant' ? ['a', canonContent(message.content), (message.tool_calls ?? []).map(call => [call.id, call.function?.name, canonArguments(call.function?.arguments)])]
  : message.role === 'tool' ? ['t', message.tool_call_id ?? '', canonContent(message.content)]
  : [message.role === 'user' ? 'u' : 's', canonContent(message.content)];
const roll = (hash: string, value: unknown) => createHash('sha256').update(hash).update(JSON.stringify(value)).digest('hex');
/** The rolling hash of a message list (the history an answer was given to). */
export const historyHash = (messages: ChatMessage[]) => messages.reduce((hash, message) => roll(hash, canon(message)), '');
/** The key of an assistant turn given the hash of the history before it. */
export const turnKey = (before: string, turn: ChatMessage) => roll(before + '|turn', canon(turn)).slice(0, 48);
/**
 * `replayFor` returns what an earlier answer stored for a turn key. The provider's structured reasoning_details are sent
 * back unchanged when there are any, otherwise its plain reasoning text (OpenRouter documents the two as alternatives).
 * `stats` counts assistant turns with and without stored reasoning; a turn that produced none counts as without.
 */
export function chatToOpenRouter(body: ChatRequest, upstreamModel: string, replayFor: (key: string) => ResponsesItem[] | undefined = () => undefined, stats: { replayed: number; withoutReplay: number } = { replayed: 0, withoutReplay: 0 }) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new GatewayError(400, 'messages must be a non-empty array');
  const messages: Record<string, unknown>[] = [];
  let before = '';
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') messages.push({ role: 'system', content: text(message.content, 'system') });
    else if (message.role === 'user') messages.push({ role: 'user', content: chatUserContent(message.content) });
    else if (message.role === 'assistant') {
      const calls = (message.tool_calls ?? []).map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments ?? '{}' } }));
      const said = text(message.content, 'assistant');
      const stored = replayFor(turnKey(before, message))?.find(item => item.type === 'openrouter_reasoning');
      const details = Array.isArray(stored?.details) && stored.details.length ? stored.details : undefined, reasoning = typeof stored?.reasoning === 'string' && stored.reasoning ? stored.reasoning : undefined;
      if (details || reasoning) stats.replayed++; else stats.withoutReplay++;
      messages.push({ role: 'assistant', content: said || null, ...(calls.length ? { tool_calls: calls } : {}), ...(details ? { reasoning_details: details } : reasoning ? { reasoning } : {}) });
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new GatewayError(400, 'tool message without tool_call_id');
      messages.push({ role: 'tool', tool_call_id: message.tool_call_id, content: text(message.content, 'tool') });
    } else throw new GatewayError(400, `Unsupported message role: ${String(message.role).slice(0, 40)}`);
    before = roll(before, canon(message));
  }
  const tools = (body.tools ?? []).filter(tool => tool.type === 'function' && tool.function?.name)
    .map(tool => ({ type: 'function', function: { name: tool.function!.name, description: tool.function!.description ?? '', parameters: cleanSchema(tool.function!.parameters) } }));
  const maxOutput = body.max_completion_tokens ?? body.max_tokens;
  const choice = body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required' ? body.tool_choice
    : (body.tool_choice as { function?: { name?: string } } | undefined)?.function?.name ? { type: 'function', function: { name: (body.tool_choice as { function: { name: string } }).function.name } } : undefined;
  // Dropped on purpose, as on the OpenAI path: temperature, verbosity, reasoning_summary, stream options and the harness's bookkeeping fields.
  return {
    model: upstreamModel, messages, stream: false,
    ...(tools.length ? { tools } : {}), ...(choice ? { tool_choice: choice } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean' ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.reasoning_effort && EFFORTS.has(body.reasoning_effort) ? { reasoning: { effort: body.reasoning_effort } } : {}),
    ...(Number.isInteger(maxOutput) && maxOutput! > 0 ? { max_tokens: maxOutput } : {}),
    // The same two formats as on the OpenAI path, passed on in Chat Completions form; anything else is dropped.
    ...(responsesFormat(body.response_format) ? { response_format: body.response_format!.type === 'json_object' ? { type: 'json_object' } : { type: 'json_schema', json_schema: body.response_format!.json_schema } } : {}),
    // The fastest host first (4 October): OpenRouter otherwise spreads calls across hosts, and on the slow ones (35 to 70
    // tokens/s) one long thinking turn used a whole agent step (DISP-010 run e761c1e9). OpenRouter still falls back on errors.
    provider: { sort: 'throughput' },
  };
}

/** The error an OpenRouter answer carries in a 200 body or on its choice, if any (the caller scrubs and reports it). */
export const openRouterError = (result: OpenRouterResult | null | undefined) => {
  const error = result?.error ?? result?.choices?.[0]?.error;
  return error ? { message: String(error.message ?? ''), code: String(error.code ?? 'upstream_failed') } : undefined;
};

export function openRouterToChat(result: OpenRouterResult, model: string, created = Math.floor(Date.now() / 1000)) {
  // OpenRouter can answer 200 with an error object, or put the error on the choice: neither is an answer.
  const choice = result?.choices?.[0];
  if (openRouterError(result) || !choice || !choice.message || choice.finish_reason === 'error') throw new GatewayError(502, 'Upstream response failed', 'upstream_failed');
  // A cut-off answer may hold truncated tool arguments: report the truncation and pass on no tool call.
  const incomplete = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter';
  const said = text(choice.message.content ?? null, 'assistant'), refusal = typeof choice.message.refusal === 'string' ? choice.message.refusal : '';
  const content = said || refusal;
  const toolCalls: ChatToolCall[] = incomplete ? [] : (choice.message.tool_calls ?? []).filter(call => call?.function?.name).map(call => ({
    id: typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID().replace(/-/g, '')}`, type: 'function' as const,
    function: { name: call.function!.name, arguments: typeof call.function!.arguments === 'string' && call.function!.arguments ? call.function!.arguments : JSON.stringify(call.function!.arguments ?? {}) },
  }));
  // Nothing said, nothing called and not cut off: not an answer the harness can use, so it is not passed on as a clean stop.
  if (!content && !toolCalls.length && !incomplete) throw new GatewayError(502, 'Upstream returned an empty response', 'upstream_empty');
  const finish = incomplete ? (choice.finish_reason === 'content_filter' ? 'content_filter' : 'length') : toolCalls.length ? 'tool_calls' : 'stop';
  const u = result.usage ?? {};
  const usage = {
    prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 }, completion_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
  };
  // The served model is what OpenRouter says it used; the requested id only when it says nothing.
  const served = typeof result.model === 'string' && result.model ? result.model : model;
  const completion = {
    id: 'chatcmpl-' + (result.id ?? `or-${randomUUID()}`), object: 'chat.completion', created, model: served,
    choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage,
  };
  const details = choice.message.reasoning_details, reasoning = choice.message.reasoning;
  const hasDetails = Array.isArray(details) && details.length > 0, hasText = typeof reasoning === 'string' && reasoning.length > 0;
  const replay: ResponsesItem[] = !incomplete && (hasDetails || hasText) ? [{ type: 'openrouter_reasoning', ...(hasDetails ? { details } : {}), ...(hasText ? { reasoning } : {}) }] : [];
  // `turn` is the answer as the harness will echo it, for the gateway to key its reasoning under.
  const turn: ChatMessage = { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  return { completion, replay, callIds: toolCalls.map(call => call.id), turn, served, provider: typeof result.provider === 'string' ? result.provider : undefined, nativeFinish: choice.native_finish_reason ?? undefined };
}
