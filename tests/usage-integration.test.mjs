import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
