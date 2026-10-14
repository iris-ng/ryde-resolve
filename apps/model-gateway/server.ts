import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chatToOpenRouter, chatToResponses, completionToSse, GatewayError, historyHash, openRouterError, openRouterToChat, responsesToChat, turnKey, viaOpenRouter, type ChatRequest, type OpenRouterResult, type ResponsesItem, type ResponsesResult } from './translate';
import { failureCategory } from '../../packages/agent-flow/failure';

// The model gateway: CodeBuddy's CODEBUDDY_BASE_URL points here. It holds the OpenAI key (the worker
// never sees it), accepts only callers presenting the shared secret, forwards only allowlisted models,
// and calls the OpenAI Responses API. It logs sizes and timings, never prompts, outputs or headers.
// From 1 October 2026 a model id of the form maker/model (deepseek/deepseek-v4.1-flash) goes to OpenRouter's
// Chat Completions API with the OpenRouter key instead; plain ids keep the OpenAI path. Each key reaches only its own upstream.
export type GatewayConfig = {
  secret: string; apiKey: string; models: ReadonlySet<string>; upstream: string;
  openrouter?: { apiKey: string; upstream: string; timeoutMs: number };
  timeoutMs: number; retries: number; keepAliveMs: number; maxBodyBytes: number; maxConcurrent: number; log: (line: Record<string, unknown>) => void;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const secret = env.RYDE_MODEL_GATEWAY_SECRET ?? '', apiKey = env.OPENAI_API_KEY ?? '';
  const models = new Set((env.RYDE_GATEWAY_MODELS ?? '').split(',').map(m => m.trim()).filter(Boolean));
  if (secret.length < 32) throw new Error('RYDE_MODEL_GATEWAY_SECRET must be at least 32 characters');
  const routed = [...models].filter(viaOpenRouter), openrouterKey = env.OPENROUTER_API_KEY ?? '';
  if (!models.size) throw new Error('RYDE_GATEWAY_MODELS must list the models this gateway may call');
  if (!apiKey && routed.length < models.size) throw new Error('OPENAI_API_KEY is required');
  if (routed.length && !openrouterKey) throw new Error('OPENROUTER_API_KEY is required for the listed maker/model ids: ' + routed.join(', '));
  return {
    // One OpenRouter attempt is capped well below a role's ten-minute task limit (five minutes until 4 October): the answer is not streamed upstream, so a slow
    // generation would otherwise use the whole task before any tool could run.
    ...(openrouterKey ? { openrouter: { apiKey: openrouterKey, upstream: (env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''), timeoutMs: Number(env.RYDE_GATEWAY_OPENROUTER_TIMEOUT_MS ?? 240000) } } : {}),
    secret, apiKey, models, upstream: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    timeoutMs: Number(env.RYDE_GATEWAY_TIMEOUT_MS ?? 600000), retries: Number(env.RYDE_GATEWAY_RETRIES ?? 2), keepAliveMs: 15000,
    maxBodyBytes: 8 * 1024 * 1024, maxConcurrent: Number(env.RYDE_GATEWAY_MAX_CONCURRENT ?? 8),
    log: line => console.log(JSON.stringify(line)),
  };
}

// A turn's replay items (encrypted reasoning, text, tool calls) keyed by the tool call ids it produced.
// Call ids come from OpenAI and are only known to the conversation that received them. Bounded by
// count, bytes and age; a miss only costs reasoning continuity, never correctness.
export class ReasoningCache {
  private entries = new Map<string, { at: number; bytes: number; items: ResponsesItem[] }>();
  private bytes = 0;
  constructor(private max = 2000, private ttlMs = 6 * 3600_000, private maxBytes = 64 * 1024 * 1024) {}
  private drop(id: string) { const entry = this.entries.get(id); if (entry) { this.bytes -= entry.bytes; this.entries.delete(id); } }
  put(callIds: string[], items: ResponsesItem[]) {
    if (!items.length || !callIds.length) return;
    const now = Date.now(), bytes = JSON.stringify(items).length;
    if (bytes > this.maxBytes) return;
    for (const [id, entry] of this.entries) { if (now - entry.at <= this.ttlMs) break; this.drop(id); } // oldest first
    for (const id of callIds) { this.drop(id); this.entries.set(id, { at: now, bytes, items }); this.bytes += bytes; }
    while (this.entries.size > this.max || this.bytes > this.maxBytes) this.drop(this.entries.keys().next().value!);
  }
  get(callId: string) {
    const entry = this.entries.get(callId);
    if (!entry || Date.now() - entry.at > this.ttlMs) { this.drop(callId); return undefined; }
    return entry.items;
  }
  get size() { return { entries: this.entries.size, bytes: this.bytes }; }
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new GatewayError(499, 'Client closed request', 'cancelled')); }, { once: true });
});
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Failures where the request provably never reached OpenAI, so a retry cannot bill twice.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
export function retryDelayMs(headers: Headers, attempt: number, now = Date.now()) {
  const ms = Number(headers.get('retry-after-ms')), after = headers.get('retry-after');
  const hinted = ms > 0 ? ms : after == null ? NaN : /^\d+(\.\d+)?$/.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - now;
  return Number.isFinite(hinted) ? Math.max(0, hinted) : 1500 * 3 ** attempt;
}

export function createGateway(config: GatewayConfig, fetchImpl: typeof fetch = fetch, cache = new ReasoningCache()) {
  const expected = digest(`Bearer ${config.secret}`);
  const authorized = (header: string | undefined) => !!header && timingSafeEqual(digest(header), expected);
  // Upstream error text goes back to the harness: never let it carry credentials.
  const keys = [config.apiKey, config.openrouter?.apiKey].filter((key): key is string => !!key);
  const scrub = (message: string) => keys.reduce((out, key) => out.split(key).join('[key]'), message).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]').slice(0, 300);
  // A 401 is always about our key. A 403 from OpenRouter can also be a content or guardrail refusal, so its (scrubbed) text is kept.
  const clean = (status: number, message: string, provider: string) => status === 401 || (status === 403 && provider === 'OpenAI')
    ? `${provider} rejected the gateway credentials or permissions`
    : scrub(message);
  let inFlight = 0;

  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > config.maxBodyBytes) throw new GatewayError(413, 'Request too large'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest; } catch { throw new GatewayError(400, 'Body is not JSON'); }
  }

  type Target = { url: string; apiKey: string; provider: string; timeoutMs: number; retryable: ReadonlySet<number>; providerRetry?: boolean };
  // Only validated identifiers and fixed labels are logged: provider text can quote a prompt, a case or a key.
  const label = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) && !keys.some(key => value.includes(key)) ? value : undefined;
  // A provider name is logged only as one short token (DeepInfra, Z.AI): a field that can hold a sentence can hold case text.
  const meta = (answer: { provider?: unknown; id?: unknown } | null | undefined) => ({ provider: label(answer?.provider, /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/), generation: label(answer?.id, /^[\w-]{1,80}$/) });
  async function callUpstream(target: Target, payload: unknown, signal: AbortSignal, stats: { retries: number; failure?: string; code?: string }): Promise<unknown> {
    // Owner decision (6 October 2026): on OpenRouter one provider error (a 502 or 503 status, or a 200 that carries one) is retried
    // once on the same model, so one bad host does not end a whole run; it may pay twice for one step. It has its own allowance,
    // separate from the 429 and network retries (attempt), and a body the gateway cannot read is not a provider error.
    let attempt = 0, providerRetried = false;
    const providerError = (code: unknown) => ['502', '503'].includes(String(code));
    for (;;) {
      const timeout = AbortSignal.timeout(target.timeoutMs);
      let response: Response;
      try {
        // redirect: 'error': the request and the key go only to the configured upstream, never where a reply points.
        response = await fetchImpl(target.url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.any([signal, timeout]) });
      } catch (error) {
        if (signal.aborted) throw new GatewayError(499, 'Client closed request', 'cancelled');
        if (timeout.aborted) throw new GatewayError(504, 'Upstream timed out', 'upstream_timeout');
        const code = String((error as { cause?: { code?: string } })?.cause?.code ?? '');
        if (NOT_SENT.has(code) && attempt < config.retries) { stats.retries++; await sleep(1500 * 3 ** attempt, signal); attempt++; continue; }
        throw new GatewayError(502, `Upstream unreachable${code ? ` (${code})` : ''}`, 'upstream_unreachable');
      }
      if (response.ok) {
        // The body can still fail or time out after the status line: report it as an upstream failure, not a gateway bug.
        let answer: unknown;
        try { answer = await response.json(); }
        catch { if (signal.aborted) throw new GatewayError(499, 'Client closed request', 'cancelled'); throw timeout.aborted ? new GatewayError(504, 'Upstream timed out', 'upstream_timeout') : new GatewayError(502, 'Upstream sent an unreadable response', 'upstream_failed'); }
        if (target.providerRetry && !providerRetried && !signal.aborted && providerError(openRouterError(answer as OpenRouterResult)?.code)) { providerRetried = true; stats.retries++; continue; }
        return answer;
      }
      // An error body may be unreadable or JSON null: it only carries text, so it never blocks a retry.
      const raw: unknown = await response.json().catch(() => null);
      const detail = (raw && typeof raw === 'object' ? raw : {}) as { error?: { message?: string; code?: string } };
      // Nothing is retried, or written, once the client has gone.
      if (signal.aborted) throw new GatewayError(499, 'Client closed request', 'cancelled');
      Object.assign(stats, { failure: failureCategory(`${response.status} ${detail.error?.message ?? ''}`), code: label(String(detail.error?.code ?? response.status), /^[\w.-]{1,40}$/) });
      if (target.providerRetry && !providerRetried && providerError(response.status)) { providerRetried = true; stats.retries++; continue; }
      if (target.retryable.has(response.status) && attempt < config.retries) {
        const wait = retryDelayMs(response.headers, attempt);
        if (wait <= 30000) { stats.retries++; await sleep(wait, signal); attempt++; continue; }
      }
      // The provider's own code is free text until validated: it is passed on only when it is a short identifier holding no key.
      throw new GatewayError(response.status, `Upstream ${response.status}: ${clean(response.status, String(detail.error?.message ?? ''), target.provider)}`, label(typeof detail.error?.code === 'string' ? detail.error.code : undefined, /^[\w.-]{1,40}$/) ?? 'upstream_error');
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now(), requestId = String(req.headers['x-request-id'] ?? randomUUID()).replace(/[^\w.-]/g, '').slice(0, 64);
    const path = (req.url ?? '').split('?')[0];
    const line: Record<string, unknown> = { at: new Date().toISOString(), requestId, path };
    const sendJson = (status: number, body: unknown) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestId }); res.end(JSON.stringify(body)); };
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    let keepAlive: NodeJS.Timeout | undefined, counted = false;
    try {
      if (req.method === 'GET' && path === '/health') return sendJson(200, { status: 'ok', models: [...config.models] });
      if (req.method !== 'POST' || !['/chat/completions', '/v1/chat/completions'].includes(path)) throw new GatewayError(404, 'Not found', 'not_found');
      if (!authorized(req.headers.authorization)) throw new GatewayError(401, 'Unauthorized', 'unauthorized');
      if (inFlight >= config.maxConcurrent) throw new GatewayError(503, 'Gateway busy', 'gateway_busy');
      inFlight++; counted = true;
      const body = await readBody(req);
      const model = String(body.model ?? '');
      Object.assign(line, { model: model.slice(0, 80), effort: body.reasoning_effort, stream: !!body.stream, messages: body.messages?.length });
      if (!config.models.has(model)) throw new GatewayError(400, `Model not allowed by this gateway: ${model.slice(0, 80)}`, 'model_not_allowed');
      const conversation = req.headers['x-conversation-id'];
      const routed = viaOpenRouter(model);
      // OpenRouter reasoning is stored per model under a hash of the conversation history up to the turn (translate.ts turnKey),
      // never under a tool-call id or a text alone.
      const replayStats = { replayed: 0, withoutReplay: 0 }, stored = (key: string) => `or:${model}:${key}`;
      if (routed && !config.openrouter) throw new GatewayError(400, `Model not allowed by this gateway: ${model.slice(0, 80)}`, 'model_not_allowed');
      line.upstream = routed ? 'openrouter' : 'openai';
      const payload = routed ? chatToOpenRouter(body, model, key => cache.get(stored(key)), replayStats)
        : chatToResponses(body, model, id => cache.get(id), typeof conversation === 'string' ? createHash('sha256').update(conversation).digest('hex').slice(0, 32) : undefined);
      // A 5xx from OpenRouter does not prove no inference ran (it also falls back between providers itself), so a 429 is retried
      // there, and a provider error only once (callUpstream, owner decision of 6 October); the OpenAI path keeps its retry set.
      const target: Target = routed ? { url: `${config.openrouter!.upstream}/chat/completions`, apiKey: config.openrouter!.apiKey, provider: 'OpenRouter', timeoutMs: config.openrouter!.timeoutMs, retryable: new Set([429]), providerRetry: true }
        : { url: `${config.upstream}/responses`, apiKey: config.apiKey, provider: 'OpenAI', timeoutMs: config.timeoutMs, retryable: RETRYABLE };
      const stats: { retries: number; failure?: string; code?: string } = { retries: 0 };
      // Replay counts are logged whether or not the call then succeeds: they are what explains a provider's refusal of a history.
      if (routed) Object.assign(line, { replayed: replayStats.replayed, withoutReplay: replayStats.withoutReplay });
      if (body.stream) {
        // Commit the stream now and keep it alive: high-effort reasoning can take minutes before the first token.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': requestId });
        keepAlive = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, config.keepAliveMs);
      }
      let result: unknown;
      try { result = await callUpstream(target, payload, abort.signal, stats); } finally { Object.assign(line, { retries: stats.retries, ...(stats.failure ? { upstreamFailure: stats.failure, upstreamCode: stats.code } : {}) }); }
      let completion, replay: ResponsesItem[], callIds: string[];
      if (routed) {
        const answer = result as OpenRouterResult, failed = openRouterError(answer);
        Object.assign(line, meta(answer));
        // A 200 that carries an error: the harness gets the scrubbed text and code; the log gets a fixed label and the code.
        if (failed) { Object.assign(line, { upstreamFailure: failureCategory(`${failed.code} ${failed.message}`), upstreamCode: label(failed.code, /^[\w.-]{1,40}$/) }); throw new GatewayError(502, `Upstream response failed (${scrub(failed.code).slice(0, 40)}): ${scrub(failed.message)}`, 'upstream_failed'); }
        const out = openRouterToChat(answer, model);
        ({ completion, replay, callIds } = out);
        Object.assign(line, { served: label(out.served, /^[\w.:\/-]{1,80}$/), nativeFinish: label(out.nativeFinish, /^[A-Za-z_]{1,30}$/) });
        if (replay.length) cache.put([stored(turnKey(historyHash(body.messages), out.turn))], replay);
      } else {
        ({ completion, replay, callIds } = responsesToChat(result as ResponsesResult, model));
        cache.put(callIds, replay);
      }
      const usage = completion.usage;
      Object.assign(line, { status: 200, retries: stats.retries, input: usage.prompt_tokens, output: usage.completion_tokens, reasoning: usage.completion_tokens_details.reasoning_tokens, cached: usage.prompt_tokens_details.cached_tokens, toolCalls: callIds.length, finish: completion.choices[0].finish_reason });
      clearInterval(keepAlive);
      if (res.writableEnded || abort.signal.aborted) return;
      if (body.stream) { for (const chunk of completionToSse(completion)) res.write(chunk); res.end(); }
      else sendJson(200, completion);
    } catch (error) {
      const failure = error instanceof GatewayError ? error : new GatewayError(500, 'Gateway error', 'gateway_error');
      Object.assign(line, { status: failure.status, error: failure.code });
      clearInterval(keepAlive);
      const payload = { error: { message: failure.message, type: failure.status >= 500 ? 'server_error' : 'invalid_request_error', code: failure.code } };
      // The client has gone (499): nothing is written to the closed response.
      if (failure.code === 'cancelled') res.destroy?.();
      // After a committed stream the status line is gone, so the error travels as an event the OpenAI client raises.
      else if (res.headersSent && !res.writableEnded) { res.write(`data: ${JSON.stringify(payload)}\n\n`); res.end(); }
      else if (!res.writableEnded) sendJson(failure.status === 499 ? 400 : failure.status, payload);
    } finally {
      clearInterval(keepAlive);
      if (counted) inFlight--;
      line.ms = Date.now() - started;
      if (path !== '/health') config.log(line);
    }
  };
}
