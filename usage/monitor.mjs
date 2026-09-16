import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const object = value => value && typeof value === 'object' ? value : {};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
const empty = () => ({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, imageInputTokens: null });

export function parseUsage(payload) {
  const root = object(payload);
  const u = object(root.usage ?? root.response?.usage ?? root.message?.usage ?? root.data?.usage);
  const gemini = object(root.usageMetadata ?? root.data?.usageMetadata);
  const result = empty();
  if (Object.keys(gemini).length) {
    result.inputTokens = count(gemini.promptTokenCount);
    result.cachedInputTokens = count(gemini.cachedContentTokenCount);
    result.reasoningTokens = count(gemini.thoughtsTokenCount);
    if (Array.isArray(gemini.promptTokensDetails)) {
      const imageDetails = gemini.promptTokensDetails.filter(detail => detail.modality === 'IMAGE');
      if (imageDetails.every(detail => count(detail.tokenCount) !== null)) result.imageInputTokens = imageDetails.reduce((sum, detail) => sum + detail.tokenCount, 0);
    }
    const output = count(gemini.candidatesTokenCount);
    result.outputTokens = output === null ? null : output + (result.reasoningTokens ?? 0);
    result.totalTokens = count(gemini.totalTokenCount);
  } else {
    const details = object(u.input_tokens_details ?? u.prompt_tokens_details);
    result.inputTokens = count(u.input_tokens ?? u.prompt_tokens);
    result.outputTokens = count(u.output_tokens ?? u.completion_tokens);
    result.cachedInputTokens = count(details.cached_tokens ?? u.cache_read_input_tokens);
    result.cacheWriteTokens = count(u.cache_creation_input_tokens);
    result.imageInputTokens = count(details.image_tokens);
    result.reasoningTokens = count((u.output_tokens_details ?? u.completion_tokens_details)?.reasoning_tokens);
    if (result.inputTokens !== null && ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u)) {
      result.inputTokens += (result.cachedInputTokens ?? 0) + (result.cacheWriteTokens ?? 0);
    }
    result.totalTokens = count(u.total_tokens);
  }
  if (result.inputTokens !== null && result.outputTokens !== null) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}

function withUsage(event, payload) {
  const usage = parseUsage(payload);
  const merged = { ...event };
  for (const [key, value] of Object.entries(usage)) if (value !== null) merged[key] = value;
  if (merged.inputTokens !== null && merged.outputTokens !== null) merged.totalTokens = merged.inputTokens + merged.outputTokens;
  merged.tokenBasis = [merged.inputTokens, merged.outputTokens, merged.totalTokens].some(value => value !== null) ? 'reported' : 'missing';
  return merged;
}

function requestBody(init) {
  if (init?.body instanceof FormData) return Object.fromEntries(['model', 'modelId', 'taskId', 'task_id', 'id'].map(key => [key, init.body.get(key)]));
  try { return typeof init?.body === 'string' ? object(JSON.parse(init.body)) : {}; } catch { return {}; }
}

function taskIdFrom(payload) {
  const value = payload?.taskId ?? payload?.task_id ?? payload?.data?.taskId ?? payload?.data?.task_id
    ?? payload?.output?.task_id ?? payload?.output?.taskId ?? payload?.data?.result?.taskId ?? payload?.data?.result?.task_id
    ?? payload?.result?.taskId ?? payload?.result?.task_id ?? payload?.Response?.TaskId ?? payload?.Response?.TaskID
    ?? payload?.data?.result?.id ?? payload?.result?.id ?? payload?.data?.id ?? payload?.id;
  return text(Number.isSafeInteger(value) ? String(value) : value);
}

function terminalStatus(payload, aggregation = false) {
  const state = responseState(payload);
  if (aggregation && ['2', '3', '4'].includes(state)) return { 2: 'completed', 3: 'failed', 4: 'interrupted' }[state];
  if (['completed', 'complete', 'finished', 'succeeded', 'succeed', 'success', 'done'].includes(state)) return 'completed';
  if (['failed', 'failure', 'fail', 'error'].includes(state)) return 'failed';
  if (['cancelled', 'canceled', 'interrupted', 'incomplete'].includes(state)) return 'interrupted';
  return null;
}

function responseState(payload) {
  return String(payload?.status ?? payload?.state ?? payload?.task_status ?? payload?.response?.status
    ?? payload?.data?.status ?? payload?.data?.state ?? payload?.data?.task_status ?? payload?.data?.result?.status ?? payload?.data?.result?.state
    ?? payload?.result?.status ?? payload?.result?.state ?? payload?.output?.task_status ?? payload?.output?.status ?? payload?.output?.state
    ?? payload?.detail?.task_status ?? payload?.detail?.status ?? payload?.detail?.state ?? payload?.Response?.Status ?? '').toLowerCase();
}

function defaultConfig() {
  const main = process.env.MAIN_APP_URL?.trim().replace(/\/+$/, '');
  return {
    endpoint: main ? main + '/api/sso/usage' : '',
    secret: process.env.USAGE_MONITOR_INTERNAL_SECRET?.trim(),
    directory: process.env.USAGE_MONITOR_OUTBOX_DIR || path.resolve('data/usage-monitor'),
  };
}

/** Only metadata from a verified SSO user and the actual OpenLux hostname is retained. */
export function createUsageMonitor({ tool, fetchImpl = (...args) => globalThis.fetch(...args), config = defaultConfig, autoDrain = true }) {
  const context = new AsyncLocalStorage();
  let draining;
  let completing = Promise.resolve();
  const configured = () => Boolean(config().endpoint && config().secret);
  const warn = () => console.warn('[usage-monitor] Reporting unavailable; retained metadata will be retried.');
  const taskPath = id => path.join(config().directory, 'tasks', createHash('sha256').update(id).digest('hex') + '.json');
  async function atomicWrite(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  }
  async function enqueue(event) {
    await atomicWrite(path.join(config().directory, 'outbox', event.requestId + '.' + event.status + '.' + randomUUID() + '.json'), event);
  }
  async function readTask(id) {
    if (!id) return null;
    try { return JSON.parse(await readFile(taskPath(id), 'utf8')); } catch { return null; }
  }
  async function drainBatch() {
    if (!configured()) return;
    const { directory, endpoint, secret } = config();
    let names;
    try { names = await readdir(path.join(directory, 'outbox')); } catch (error) { if (error.code !== 'ENOENT') warn(); return; }
    for (const name of names.filter(name => name.endsWith('.json')).sort().slice(0, 10)) {
      const file = path.join(directory, 'outbox', name);
      try {
        const body = await readFile(file, 'utf8');
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-usage-tool': tool, 'x-usage-secret': secret },
          body, signal: AbortSignal.timeout(2000),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.success !== true) break;
        await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') warn(); break; }
    }
  }
  function drain() {
    if (!draining) draining = drainBatch().finally(() => { draining = undefined; });
    return draining;
  }
  const schedule = () => { if (autoDrain) void drain().catch(warn); };
  function completeTask(id, status, payload = {}) {
    const active = context.getStore();
    completing = completing.catch(() => {}).then(async () => {
      if (!configured()) return;
      const current = await readTask(id);
      if (!current || current.status !== 'pending' || (active && active.userId !== current.userId)) return;
      const normalized = terminalStatus({ status });
      if (!normalized) return;
      const event = { ...withUsage(current, payload), status: normalized };
      await enqueue(event);
      await atomicWrite(taskPath(id), event);
      schedule();
    });
    return completing;
  }
  async function observedFetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.openlux.ai' || !configured()) return fetchImpl(input, init);
    const body = requestBody(init);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const isDownload = /\/(content|download|files|upload|material)(\/|$)/i.test(url.pathname);
    const isPoll = !isDownload && (method === 'GET' || /query|status|recordInfo|retrieve/i.test(url.pathname));
    const polledId = isPoll ? text(body.taskId ?? body.task_id ?? body.id ?? url.searchParams.get('taskId')
      ?? url.searchParams.get('task_id') ?? url.searchParams.get('id') ?? url.pathname.match(/\/(?:videos|tasks|query|requests|responses)\/([^/]+)/i)?.[1]) : null;
    if (isPoll) {
      const response = await fetchImpl(input, init);
      try {
        if (response.ok) {
          const payload = await response.clone().json();
          const returnedTaskId = taskIdFrom(payload);
          const status = terminalStatus(payload, url.pathname.includes('/openApi/'));
          if (status && (returnedTaskId || (!payload?.error && payload?.success !== false))) {
            await completeTask(returnedTaskId || polledId, status, payload);
          }
        }
      } catch { warn(); }
      return response;
    }
    const falModel = url.pathname.match(/^\/(openai\/gpt-image-2(?:\/edit)?)\/?$/)?.[1];
    const model = text(body.model ?? body.modelId ?? body.model_version ?? body.model_name ?? url.pathname.match(/\/models\/([^/:]+):(?:streamGenerateContent|generateContent)/)?.[1] ?? falModel);
    const userId = context.getStore()?.userId;
    if (method !== 'POST' || isDownload || isPoll || !model || !userId) return fetchImpl(input, init);
    const event = { ...empty(), userId, requestId: randomUUID(), provider: url.hostname, model, status: 'pending', tokenBasis: 'missing' };
    try { await enqueue(event); } catch { warn(); }
    let response;
    try { response = await fetchImpl(input, init); }
    catch (error) {
      try { await enqueue({ ...event, status: 'failed' }); schedule(); } catch { warn(); }
      throw error;
    }
    try {
      const payload = await response.clone().json();
      const accepted = response.status === 202 || ['pending', 'queued', 'processing', 'running', 'in_progress', 'submitted'].includes(responseState(payload));
      const asyncEndpoint = /\/videos?(?:\/|$)|\/tasks(?:\/|$)|\/jobs\/createTask|\/openApi\/generate|\/luma\/generations|\/(?:video_generation|image_to_video|text_to_video|aigc-video)(?:\/|$)/i.test(url.pathname)
        || Boolean(falModel) || accepted || Boolean(payload?.task_id ?? payload?.taskId ?? payload?.data?.task_id ?? payload?.data?.taskId ?? payload?.output?.task_id);
      const id = asyncEndpoint ? (taskIdFrom(payload) || (falModel ? text(payload?.request_id ?? payload?.requestId) : null)) : null;
      const state = !response.ok || payload?.error || payload?.success === false ? 'failed'
        : (terminalStatus(payload, url.pathname.includes('/openApi/')) || (asyncEndpoint ? 'pending' : 'completed'));
      const completed = {
        ...withUsage(event, payload), status: state,
        upstreamRequestId: text(response.headers.get('x-request-id')) || id,
      };
      if (id && state === 'pending') await atomicWrite(taskPath(id), completed);
      await enqueue(completed);
    } catch {
      try { await enqueue({ ...event, status: response.ok ? 'interrupted' : 'failed' }); } catch { warn(); }
    }
    schedule();
    return response;
  }
  return {
    configured, fetch: observedFetch, drain, completeTask,
    run(userId, callback) { schedule(); return context.run({ userId: typeof userId === 'string' && userId.length <= 100 ? userId.trim() : null }, callback); },
  };
}
