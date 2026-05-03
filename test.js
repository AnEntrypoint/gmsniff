import assert from 'assert';
import { createServer } from './src/server.js';
import os from 'os';
import path from 'path';

const logDir = process.env.GM_LOG_DIR || path.join(os.homedir(), '.claude', 'gm-log');
const { url, close } = await createServer({ logDir, port: 0 });

async function get(p) {
  const r = await fetch(url + p);
  assert.strictEqual(r.status, 200, `${p} → ${r.status}`);
  return r.json();
}

const snap = await get('/api/snapshot');
assert(typeof snap.total === 'number', 'snapshot.total is number');
assert(Array.isArray(snap.subsystems), 'snapshot.subsystems');

const days = await get('/api/days');
assert(Array.isArray(days), 'days is array');

const evs = await get('/api/events?limit=10');
assert(typeof evs.total === 'number', 'events.total');
assert(Array.isArray(evs.rows), 'events.rows');

const recall = await get('/api/recall');
assert(typeof recall.total === 'number', 'recall.total');
assert(typeof recall.hitRate === 'string', 'recall.hitRate');

const exec_ = await get('/api/exec');
assert(typeof exec_.total === 'number', 'exec.total');

const hooks = await get('/api/hooks');
assert(typeof hooks.total === 'number', 'hooks.total');

const search = await get('/api/search?q=hook');
assert(Array.isArray(search.results), 'search.results');

const ets = await get('/api/event-types');
assert(Array.isArray(ets), 'event-types');

const pids = await get('/api/pids');
assert(Array.isArray(pids), 'pids');

const gui = await fetch(url + '/');
assert.strictEqual(gui.status, 200, 'GUI / → 200');
const html = await gui.text();
assert(html.includes('gmsniff'), 'GUI has title');

await close();
console.log(`gmsniff OK — ${snap.total} events across ${days.length} days`);
