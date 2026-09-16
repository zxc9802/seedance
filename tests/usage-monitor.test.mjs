import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUsageMonitor, parseUsage } from '../usage/monitor.mjs';

async function fixture(t, upstream) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openlux-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = [];
  let available = false;
  const config = () => ({ directory, endpoint: 'https://main.test/api/sso/usage', secret: 'test-only-reporting-secret' });
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://main.test/')) {
      reports.push(JSON.parse(init.body));
      return Response.json({ success: available }, { status: available ? 200 : 503 });
    }
    return upstream(url, init);
  };
  const options = { tool: 'seedance', fetchImpl, config, autoDrain: false };
  return { monitor: createUsageMonitor(options), restart: () => createUsageMonitor(options), directory, reports, online: () => { available = true; } };
}
const generate = (model = 'gpt-image-2-c') => ({ method: 'POST', body: JSON.stringify({ model, prompt: 'PRIVATE PROMPT', userId: 'forged-user' }) });

test('real hostname and verified user gate generation reporting; downloads and polling are not new bills', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ url: 'PRIVATE IMAGE URL' }] }));
  await f.monitor.run('alice', async () => {
    await f.monitor.fetch('https://yunwu.ai/v1/images/generations', generate());
    await f.monitor.fetch('https://api.openlux.ai.evil.test/v1/images/generations', generate());
    await f.monitor.fetch('https://api.openlux.ai/v1/videos/a/content');
    await f.monitor.fetch('https://api.openlux.ai/v1/videos/a');
  });
  await f.monitor.run(null, () => f.monitor.fetch('https://api.openlux.ai/v1/images/generations', generate()));
  await f.monitor.drain();
  assert.equal(f.reports.length, 0);
});

test('metadata survives delivery failure and process restart with the same request ID', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ b64_json: 'PRIVATE IMAGE' }] }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/v1/images/generations', generate()));
  await f.monitor.drain();
  assert.ok(f.reports.length);
  const queued = await readdir(path.join(f.directory, 'outbox'));
  const disk = (await Promise.all(queued.map(file => readFile(path.join(f.directory, 'outbox', file), 'utf8')))).join('');
  assert.doesNotMatch(disk, /PRIVATE|forged|secret|b64_json|prompt/);
  const requestId = f.reports[0].requestId;
  f.online();
  await f.restart().drain();
  const terminal = f.reports.find(event => event.status === 'completed');
  assert.equal(terminal.requestId, requestId);
  assert.equal(terminal.userId, 'alice');
  assert.equal(terminal.inputTokens, null);
  assert.equal(terminal.totalTokens, null);
  assert.equal(terminal.tokenBasis, 'missing');
  assert.equal((await readdir(path.join(f.directory, 'outbox'))).length, 0);
});

test('retries are distinct actual attempts and concurrent employees never cross', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => {
    if (++attempts === 1) throw new Error('offline');
    await new Promise(resolve => setTimeout(resolve, 2));
    return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } });
  });
  await f.monitor.run('alice', async () => {
    await assert.rejects(f.monitor.fetch('https://api.openlux.ai/v1/chat/completions', generate('gpt-6-astra')), /offline/);
    await f.monitor.fetch('https://api.openlux.ai/v1/chat/completions', generate('gpt-6-astra'));
  });
  await Promise.all(['bob', 'carol'].map(user => f.monitor.run(user, () => f.monitor.fetch('https://api.openlux.ai/v1/chat/completions', generate(user)))));
  f.online();
  await f.monitor.drain();
  await f.monitor.drain();
  const terminal = f.reports.filter(event => event.status !== 'pending');
  assert.equal(terminal.length, 4);
  assert.equal(new Set(terminal.map(event => event.requestId)).size, 4);
  assert.equal(terminal.find(event => event.model === 'bob').userId, 'bob');
  assert.equal(terminal.find(event => event.model === 'carol').userId, 'carol');
  assert.equal(terminal.filter(event => event.userId === 'alice' && event.status === 'failed').length, 1);
});

test('async creation remains pending; persisted task completes once after polling under its original owner', async t => {
  let pollStatus = 'processing';
  const f = await fixture(t, async (_url, init) => Response.json(init?.method === 'POST'
    ? { id: 'task-1', status: 'queued' }
    : { id: 'task-1', status: pollStatus, usage: { input_tokens: 20, output_tokens: 3 } }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/v1/videos', generate('veo_3_1')));
  f.online();
  await f.monitor.drain();
  assert.ok(f.reports.every(event => event.status === 'pending'));
  const restarted = f.restart();
  pollStatus = 'completed';
  await restarted.run('bob', () => restarted.fetch('https://api.openlux.ai/v1/videos/task-1'));
  await restarted.drain();
  assert.ok(f.reports.every(event => event.status === 'pending'));
  await restarted.run('alice', () => restarted.fetch('https://api.openlux.ai/v1/videos/task-1'));
  await restarted.run('alice', () => restarted.fetch('https://api.openlux.ai/v1/videos/task-1'));
  await restarted.drain();
  const complete = f.reports.filter(event => event.status === 'completed');
  assert.equal(complete.length, 1);
  assert.equal(complete[0].userId, 'alice');
  assert.equal(complete[0].requestId, f.reports[0].requestId);
  assert.equal(complete[0].inputTokens, 20);
});

test('Token parsing keeps null and zero, image detail, cache and reasoning totals', () => {
  assert.equal(parseUsage({}).totalTokens, null);
  assert.equal(parseUsage({ usage: { input_tokens: 0, output_tokens: 0 } }).totalTokens, 0);
  const image = parseUsage({ usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { image_tokens: 80, cached_tokens: 10 } } });
  assert.equal(image.imageInputTokens, 80);
  assert.equal(image.cachedInputTokens, 10);
  assert.equal(image.totalTokens, 105);
  const claude = parseUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 } });
  assert.equal(claude.inputTokens, 60);
  assert.equal(claude.totalTokens, 65);
  const gemini = parseUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 10 } });
  assert.equal(gemini.outputTokens, 25);
  assert.equal(gemini.totalTokens, 125);
  assert.equal(parseUsage({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 999 } }).totalTokens, 12);
  assert.equal(parseUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 20 }, { modality: 'IMAGE', tokenCount: 80 }] } }).imageInputTokens, 80);
});

test('aggregation query failures do not terminate paid work; numeric actual terminal states do', async t => {
  let answer = { success: false, message: 'query temporarily unavailable' };
  const f = await fixture(t, async (url) => Response.json(String(url).endsWith('/generate')
    ? { data: { taskId: 'aggregate-task', status: 0 } } : answer));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/openApi/generate', generate('veo_3_1')));
  const poll = () => f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/openApi/queryResult', { method: 'POST', body: JSON.stringify({ taskId: 'aggregate-task' }) }));
  await poll();
  f.online();
  await f.monitor.drain();
  assert.ok(f.reports.every(event => event.status === 'pending'));
  answer = { data: { taskId: 'aggregate-task', status: 2 } };
  await poll();
  await f.monitor.drain();
  assert.equal(f.reports.filter(event => event.status === 'completed').length, 1);
});

test('concurrent polls enqueue only one terminal record', async t => {
  const f = await fixture(t, async (_url, init) => Response.json(init?.method === 'POST'
    ? { id: 'race-task', status: 'queued' } : { id: 'race-task', status: 'completed' }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/v1/videos', generate('veo_3_1')));
  await f.monitor.run('alice', () => Promise.all(Array.from({ length: 4 }, () => f.monitor.fetch('https://api.openlux.ai/v1/videos/race-task'))));
  f.online();
  await f.monitor.drain();
  assert.equal(f.reports.filter(event => event.status === 'completed').length, 1);
});

test('HTTP 200 without an explicit successful acknowledgement retains the outbox', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'usage-ack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let acknowledgement = () => Response.json({ success: false });
  const monitor = createUsageMonitor({ tool: 'seedance', autoDrain: false,
    config: () => ({ directory, endpoint: 'https://main.test/api/sso/usage', secret: 'test-secret' }),
    fetchImpl: async url => String(url).startsWith('https://main.test') ? acknowledgement() : Response.json({ data: [{ url: 'private' }] }),
  });
  await monitor.run('alice', () => monitor.fetch('https://api.openlux.ai/v1/images/generations', generate()));
  await monitor.drain();
  const before = await readdir(path.join(directory, 'outbox'));
  assert.ok(before.length);
  acknowledgement = () => new Response('<html>login</html>');
  await monitor.drain();
  assert.deepEqual(await readdir(path.join(directory, 'outbox')), before);
  acknowledgement = () => Response.json({ success: true });
  await monitor.drain();
  assert.equal((await readdir(path.join(directory, 'outbox'))).length, 0);
});

test('image fan-out records each real request once and never infers Token from image count', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ b64_json: 'one-image' }] }));
  await f.monitor.run('alice', () => Promise.all(Array.from({ length: 3 }, () => f.monitor.fetch('https://api.openlux.ai/v1/images/generations', generate()))));
  f.online();
  await f.monitor.drain();
  const completed = f.reports.filter(event => event.status === 'completed');
  assert.equal(completed.length, 3);
  assert.equal(new Set(completed.map(event => event.requestId)).size, 3);
  assert.ok(completed.every(event => event.inputTokens === null && event.outputTokens === null));
});

test('an explicit async task identifier remains pending on alternate video endpoints', async t => {
  const f = await fixture(t, async () => Response.json({ output: { task_id: 'wan-task', task_status: 'PENDING' } }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/api/v1/services/aigc/video-generation/video-synthesis', generate('wan2.6-r2v')));
  f.online();
  await f.monitor.drain();
  assert.ok(f.reports.length);
  assert.ok(f.reports.every(event => event.status === 'pending'));
});

test('accepted or in-progress text responses stay pending and incomplete output is interrupted', async t => {
  const answers = [Response.json({ id: 'accepted' }, { status: 202 }), Response.json({ id: 'running', status: 'in_progress' }), Response.json({ status: 'incomplete' })];
  const f = await fixture(t, async () => answers.shift());
  await f.monitor.run('alice', async () => {
    for (let i = 0; i < 3; i++) await f.monitor.fetch('https://api.openlux.ai/v1/responses', generate('gpt-6-astra'));
  });
  f.online();
  await f.monitor.drain();
  assert.equal(f.reports.filter(event => event.status === 'completed').length, 0);
  assert.equal(f.reports.filter(event => event.status === 'interrupted').length, 1);
});

test('nested provider polling paths use the actual task ID returned by upstream', async t => {
  const f = await fixture(t, async (_url, init) => Response.json({ data: { task_id: 'kling-task', task_status: init?.method === 'POST' ? 'submitted' : 'succeed' } }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/kling/v1/videos/text2video', generate('kling-v2-6')));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/kling/v1/videos/text2video/kling-task'));
  f.online();
  await f.monitor.drain();
  assert.equal(f.reports.filter(event => event.status === 'completed').length, 1);
});

test('Luma creation with only a root ID waits for its generation polling terminal', async t => {
  const f = await fixture(t, async (_url, init) => Response.json(init?.method === 'POST' ? { id: 'luma-task' } : { id: 'luma-task', state: 'completed' }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/luma/generations', { method: 'POST', body: JSON.stringify({ model_name: 'ray-2' }) }));
  f.online();
  await f.monitor.drain();
  assert.ok(f.reports.every(event => event.status === 'pending'));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/luma/generations/luma-task'));
  await f.monitor.drain();
  assert.equal(f.reports.filter(event => event.status === 'completed').length, 1);
});

test('a model encoded in the configured fal-style URL keeps its exact model and async request ID', async t => {
  const f = await fixture(t, async (_url, init) => Response.json(init?.method === 'POST' ? { request_id: 'fal-task' } : { status: 'COMPLETED' }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/openai/gpt-image-2/edit', { method: 'POST', body: JSON.stringify({ prompt: 'private' }) }));
  f.online();
  await f.monitor.drain();
  assert.ok(f.reports.length);
  assert.ok(f.reports.every(event => event.status === 'pending' && event.model === 'openai/gpt-image-2/edit'));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/openai/gpt-image-2/requests/fal-task/status'));
  await f.monitor.drain();
  assert.equal(f.reports.filter(event => event.status === 'completed').length, 1);
});

test('an explicit failed task with error details is terminal while query errors are not', async t => {
  const f = await fixture(t, async (_url, init) => Response.json(init?.method === 'POST'
    ? { id: 'failed-task', status: 'queued' }
    : { id: 'failed-task', status: 'failed', error: { code: 'generation_failed', message: 'PRIVATE' } }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/v1/videos', generate('veo_3_1')));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/v1/videos/failed-task'));
  f.online();
  await f.monitor.drain();
  const failed = f.reports.filter(event => event.status === 'failed');
  assert.equal(failed.length, 1);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|generation_failed/);
});

test('Tencent task envelopes preserve the sent model version and complete their original request', async t => {
  const f = await fixture(t, async (_url, init) => Response.json({ Response: { TaskId: 'native-task', ...(init?.method === 'POST' ? {} : { Status: 'SUCCESS' }) } }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/tencent-vod/v1/aigc-video', { method: 'POST', body: JSON.stringify({ model_name: 'Kling', model_version: 'v2.6' }) }));
  await f.monitor.run('alice', () => f.monitor.fetch('https://api.openlux.ai/tencent-vod/v1/query/native-task'));
  f.online();
  await f.monitor.drain();
  const complete = f.reports.filter(event => event.status === 'completed');
  assert.equal(complete.length, 1);
  assert.equal(complete[0].model, 'v2.6');
});
