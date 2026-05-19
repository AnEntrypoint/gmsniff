import assert from 'assert';
import { createServer } from './src/server.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

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

// --- Live feedback (SSE) regression ---
// Use a dedicated temp logDir so we control appends without depending on real activity.
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-live-'));
const liveDay = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.join(liveDir, liveDay), { recursive: true });
const liveFile = path.join(liveDir, liveDay, 'plugkit.jsonl');
fs.writeFileSync(liveFile, '');

const live = await createServer({ logDir: liveDir, port: 0 });

const received = [];
let helloSeen = false;
await new Promise((resolve, reject) => {
  const req = http.get(live.url + '/api/stream', res => {
    assert.strictEqual(res.statusCode, 200, 'SSE status');
    assert.match(res.headers['content-type'] || '', /text\/event-stream/, 'SSE content-type');
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const l of frame.split('\n')) {
          if (l.startsWith('event: ')) event = l.slice(7);
          else if (l.startsWith('data: ')) data += l.slice(6);
        }
        if (event === 'hello') helloSeen = true;
        else if (event === 'event') { try { received.push(JSON.parse(data)); } catch {} }
      }
    });
    res.on('error', reject);
  });
  req.on('error', reject);
  // wait for hello, then append, then wait for match
  (async () => {
    const helloDl = Date.now() + 3000;
    while (Date.now() < helloDl && !helloSeen) await new Promise(r => setTimeout(r, 50));
    assert(helloSeen, 'SSE hello not received');
    const marker = 'LIVE_TEST_' + Date.now();
    fs.appendFileSync(liveFile, JSON.stringify({ ts: new Date().toISOString(), event: 'live.test', pid: process.pid, marker }) + '\n');
    const dl = Date.now() + 5000;
    while (Date.now() < dl && !received.some(e => e.marker === marker)) await new Promise(r => setTimeout(r, 100));
    assert(received.some(e => e.marker === marker), `SSE did not deliver appended jsonl line within 5s (got ${received.length} events)`);
    req.destroy();
    resolve();
  })().catch(reject);
});

await live.close();
fs.rmSync(liveDir, { recursive: true, force: true });

await close();
console.log(`gmsniff OK — ${snap.total} events across ${days.length} days · live-feedback verified`);
