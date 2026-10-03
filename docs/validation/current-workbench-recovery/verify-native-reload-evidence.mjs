#!/usr/bin/env node
/** Read-only diagnostic oracle, independent of product implementation. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = resolve(process.argv[2]);
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
let checks = 0;
const equal = (actual, expected, message) => { checks++; assert.deepEqual(actual, expected, message); };
const check = (condition, message) => { checks++; assert.ok(condition, message); };
equal(report.status, 'diagnostic-ready-reload-passed', 'This is a ready-reload diagnostic only');
equal(report.errors, [], 'No renderer or assertion failures');
equal(report.cleanup.completed, true, 'Owned cleanup complete');
equal(report.cleanup.processes_verified_exited, true, 'Owned Host processes exited');
equal(report.cleanup.failures, [], 'No ignored cleanup failures');
equal(report.provider_requests, [], 'No model/provider request');
const result = report.native_ready_reload;
equal(result.observations.length, 2, 'One actual before and after observation');
equal(result.observations.map(o => o.name), ['fully-ready-before-reload', 'fully-ready-after-reload'], 'Exact observation identities');
for (const observation of result.observations) {
  const bytes = await readFile(join(directory, observation.file));
  equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), observation.sha256, 'Actual screenshot SHA');
  equal(bytes.length, observation.bytes, 'Actual screenshot byte count');
  equal([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10], 'PNG signature');
  equal(bytes.readUInt32BE(16), observation.png_width, 'Actual PNG width');
  equal(bytes.readUInt32BE(20), observation.png_height, 'Actual PNG height');
  equal(observation.document.ready_state, 'complete', 'Actual ready native document');
  equal(observation.document.composer_count, 1, 'One usable actual composer');
  equal(observation.connection.state, 'connected', 'Actual fixed native bridge connected');
}
equal(result.observations[0].connection, result.observations[1].connection, 'Reload retained identical authenticated owner/generation');
for (const key of ['same_owner','no_provider_request','no_run_created']) equal(result[key], true, key);
check(result.elapsed_ms >= 0 && result.elapsed_ms < 30000, 'Usable ready reload within the existing deadline');
check(Date.parse(result.observations[1].recorded_at) >= Date.parse(result.requested_at), 'Actual after timestamp follows the explicit request');
check(!report.native_page_events.some(event => event.event === 'crash'), 'No observed renderer crash');
process.stdout.write(JSON.stringify({ status: 'diagnostic-verified', checks, screenshots: 2, boundary: 'Fully-ready native reload only; does not prove the cause or resolution of earlier initial-navigation timeouts and does not claim full GUI coverage.' }) + '\n');
