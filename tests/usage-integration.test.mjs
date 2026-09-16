import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVideoRelayClient } from '../relay/videoRelayClient.js';
import { createUsageMonitor } from '../usage/monitor.mjs';

test('all server fetch attempts share the SSO-scoped observer without changing global fetch', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /const fetch = usageMonitor.fetch/);
  assert.match(source, /usageMonitor.run\(req.videoSiteSession\?\.user\?\.id, next\)/);
  assert.doesNotMatch(source, /globalThis.fetch\s*=/);
});

test('existing background task updates feed canonical terminal metadata and retry loop drains the outbox', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /async function queryAggregationTaskStatusForSync/);
  assert.match(server, /async function requestJson[\s\S]*?await fetch\(/);
  assert.match(server, /await usageMonitor.drain\(\)/);
});

for (const status of ['completed', 'failed']) test(`target relay wiring restores ${status} polling without an echoed ID under the original SSO owner`, async t => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const initializer = source.match(/const videoRelayClient = (createVideoRelayClient\(\{[\s\S]*?\n\}\))/)?.[1];
  assert.ok(initializer);
  const construct = new Function('createVideoRelayClient', 'videoRelayApiBaseUrl', 'videoRelayApiKey', 'fetch', 'return ' + initializer);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seedance-relay-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = [];
  const upstreamCalls = [];
  const previousFetch = globalThis.fetch;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://main.test')) {
      reports.push(JSON.parse(init.body));
      return Response.json({ success: true });
    }
    upstreamCalls.push({ url, init });
    return init.method === 'POST'
      ? Response.json({ id: 'relay-task', status: 'processing' }, { status: 202 })
      : Response.json({ status, ...(status === 'failed' ? { error: { code: 'generation_failed' } } : {}), usage: { input_tokens: 40, output_tokens: 5 } });
  };
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = previousFetch; });
  const options = { tool: 'seedance', autoDrain: false, fetchImpl, config: () => ({ directory, endpoint: 'https://main.test/api/sso/usage', secret: 'fake' }) };
  const monitor = createUsageMonitor(options);
  const body = { modelId: 'doubao-seedance-2-5', prompt: 'private prompt', payload: { params: { mode: 'text_to_video' } } };
  const client = construct(createVideoRelayClient, 'https://api.openlux.ai', 'fake-key', monitor.fetch);
  // API-key relay calls have no verified SSO context; a configured non-OpenLux relay is also excluded.
  await client.submit(body);
  await monitor.run('alice', () => construct(createVideoRelayClient, 'https://relay.example', 'fake-key', monitor.fetch).submit(body));
  await monitor.drain();
  assert.equal(reports.length, 0);
  await monitor.run('alice', () => client.submit(body, { idempotencyKey: 'business-reservation' }));
  await monitor.drain();
  assert.ok(reports.length > 0, 'the server relay client must use the monitored fetch');
  assert.ok(reports.every(event => event.status === 'pending' && event.userId === 'alice'));
  const requestId = reports[0].requestId;
  const recovered = createUsageMonitor(options);
  const pollClient = construct(createVideoRelayClient, 'https://api.openlux.ai', 'fake-key', recovered.fetch);
  await recovered.run('bob', () => pollClient.query('relay-task'));
  await recovered.drain();
  assert.equal(reports.filter(event => event.status !== 'pending').length, 0);
  await pollClient.query('relay-task'); // Existing maintenance loop has no browser request context.
  await pollClient.query('relay-task');
  await recovered.drain();
  const terminal = reports.filter(event => event.status !== 'pending');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].status, status);
  assert.equal(terminal[0].requestId, requestId);
  assert.equal(terminal[0].userId, 'alice');
  assert.equal(terminal[0].model, body.modelId);
  assert.equal(terminal[0].totalTokens, 45);
  assert.ok(upstreamCalls.some(call => call.url === 'https://api.openlux.ai/v1/videos/generations/relay-task' && call.init.method === 'GET'));
  assert.equal(upstreamCalls[2].init.headers['Idempotency-Key'], 'business-reservation');
  assert.ok(source.indexOf("app.use('/v1', seedanceRelayRouter)") < source.indexOf('usageMonitor.run(req.videoSiteSession'));
});
