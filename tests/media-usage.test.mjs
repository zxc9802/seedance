import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaUsageEvent } from '../db/usage.js';

test('only async media terminal logs are reported, using supplier cost rather than wallet charge', () => {
  const row = {id:'log-1',user_id:'employee-1',channel:'aggregation',provider_id:'seedance1',
    model:'seedance-test',status:'submitted',upstream_cost_cny:'5',sale_price_cny:'9',charged_credits:900};
  assert.equal(mediaUsageEvent(row), undefined);
  const report = mediaUsageEvent({...row,status:'succeeded'});
  assert.equal(report.requestId,'usage-log:log-1');
  assert.equal(mediaUsageEvent({...row,status:'succeeded'}).requestId,report.requestId);
  assert.equal(report.amount,5);
  assert.equal(report.costBasis,'estimated');
  assert.equal(report.currency,'CNY');
  assert.equal(report.totalTokens,null);
  assert.equal(mediaUsageEvent({...row,status:'failed'}).amount,undefined);
  assert.equal(mediaUsageEvent({...row,status:'succeeded',channel:'copywriting'}),undefined);
  assert.equal(mediaUsageEvent({...row,status:'succeeded',channel:'image',provider_id:'gpt-image2'}),undefined);
  assert.equal(mediaUsageEvent({...row,status:'succeeded',channel:'image',provider_id:'gemini-image-aggregation'}).amount,5);
});
