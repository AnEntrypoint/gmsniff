import assert from 'assert';
import { createServer } from './src/server.js';
import { DEFAULT_LOG_DIR } from './src/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawnSync } from 'child_process';

const logDir = DEFAULT_LOG_DIR;
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

// --- Multi-project live fanout (server-side) ---
// Two fake discovered projects, each with its own .gm/exec-spool/.watcher.log (evt: line
// format, same shape gm-plugkit's watcher actually writes). GM_SPOOL_DIRS points
// discoverSpoolLogs/MultiProjectWatcher at a dedicated temp root so this test is isolated
// from any real projects on the machine. Verifies: concurrent per-project tailing, cwd
// attribution preserved per event, dynamic appearance (a third project added after the
// server/fanout already started) picked up without restart, and cwd-spoof resistance (a
// crafted evt: line claiming a foreign cwd must be overridden by the real discovered cwd).
const fanoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-fanout-'));
function makeProject(name) {
  const proj = path.join(fanoutRoot, name);
  const spoolDir = path.join(proj, '.gm', 'exec-spool');
  fs.mkdirSync(spoolDir, { recursive: true });
  const logFp = path.join(spoolDir, '.watcher.log');
  fs.writeFileSync(logFp, '');
  return { proj: path.resolve(proj), logFp };
}
const projA = makeProject('proj-a');
const projB = makeProject('proj-b');

const prevSpoolDirs = process.env.GM_SPOOL_DIRS;
process.env.GM_FANOUT_REDISCOVER_MS = '300';
process.env.GM_SPOOL_DIRS = [projA.proj, projB.proj].join(path.delimiter);

const fanoutSrv = await createServer({ logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-empty-')), port: 0 });

const fanoutReceived = [];
let fanoutHello = false;
const projectEvents = [];
let projC; // assigned inside the promise body below, read after it resolves (dynamic-rediscovery block)
await new Promise((resolve, reject) => {
  const req = http.get(fanoutSrv.url + '/api/stream', res => {
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
        if (event === 'hello') fanoutHello = true;
        else if (event === 'event') { try { fanoutReceived.push(JSON.parse(data)); } catch {} }
        else if (event === 'project.added' || event === 'project.removed') { try { projectEvents.push({ event, data: JSON.parse(data) }); } catch {} }
      }
    });
    res.on('error', reject);
  });
  req.on('error', reject);
  (async () => {
    const helloDl = Date.now() + 3000;
    while (Date.now() < helloDl && !fanoutHello) await new Promise(r => setTimeout(r, 50));
    assert(fanoutHello, 'fanout SSE hello not received');

    const markerA = 'FANOUT_A_' + Date.now();
    const markerB = 'FANOUT_B_' + Date.now();
    fs.appendFileSync(projA.logFp, `2026-07-06 evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'dispatch.end', marker: markerA })}\n`);
    fs.appendFileSync(projB.logFp, `2026-07-06 evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'dispatch.end', marker: markerB })}\n`);
    // cwd-spoof attempt: crafted line claims cwd of project A while written into project B's log.
    const spoofMarker = 'FANOUT_SPOOF_' + Date.now();
    fs.appendFileSync(projB.logFp, `evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'dispatch.end', marker: spoofMarker, cwd: projA.proj })}\n`);

    const dl = Date.now() + 6000;
    while (Date.now() < dl && !(fanoutReceived.some(e => e.marker === markerA) && fanoutReceived.some(e => e.marker === markerB) && fanoutReceived.some(e => e.marker === spoofMarker))) {
      await new Promise(r => setTimeout(r, 100));
    }
    const evA = fanoutReceived.find(e => e.marker === markerA);
    const evB = fanoutReceived.find(e => e.marker === markerB);
    const evSpoof = fanoutReceived.find(e => e.marker === spoofMarker);
    assert(evA, `project A event not received (got ${fanoutReceived.length} events)`);
    assert(evB, `project B event not received (got ${fanoutReceived.length} events)`);
    assert.strictEqual(path.resolve(evA.cwd), projA.proj, 'project A event cwd attribution');
    assert.strictEqual(path.resolve(evB.cwd), projB.proj, 'project B event cwd attribution');
    assert(evSpoof, 'spoofed-cwd event not received');
    assert.strictEqual(path.resolve(evSpoof.cwd), projB.proj, 'spoofed cwd field must be overridden by the real discovered project B cwd, not the claimed project A cwd');

    // Dynamic rediscovery: a third project appears on disk after the fanout already started.
    projC = makeProject('proj-c');
    process.env.GM_SPOOL_DIRS = [projA.proj, projB.proj, projC.proj].join(path.delimiter);
    const addedDl = Date.now() + 3000;
    while (Date.now() < addedDl && !projectEvents.some(p => p.event === 'project.added' && path.resolve(p.data.cwd) === projC.proj)) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert(projectEvents.some(p => p.event === 'project.added' && path.resolve(p.data.cwd) === projC.proj), 'project.added not observed for newly-appeared project C within rediscovery window');

    const markerC = 'FANOUT_C_' + Date.now();
    fs.appendFileSync(projC.logFp, `evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'dispatch.end', marker: markerC })}\n`);
    const cDl = Date.now() + 4000;
    while (Date.now() < cDl && !fanoutReceived.some(e => e.marker === markerC)) await new Promise(r => setTimeout(r, 100));
    assert(fanoutReceived.some(e => e.marker === markerC), 'newly-discovered project C event not delivered live without restart');

    // Disappearance: delete project B's log file, expect project.removed within rediscovery window.
    fs.rmSync(projB.logFp, { force: true });
    process.env.GM_SPOOL_DIRS = [projA.proj, projC.proj].join(path.delimiter);
    const removedDl = Date.now() + 3000;
    while (Date.now() < removedDl && !projectEvents.some(p => p.event === 'project.removed' && path.resolve(p.data.cwd) === projB.proj)) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert(projectEvents.some(p => p.event === 'project.removed' && path.resolve(p.data.cwd) === projB.proj), 'project.removed not observed after project B watcher.log disappeared');

    req.destroy();
    resolve();
  })().catch(reject);
});

// /api/projects surfaces watching=true for a fanout-covered project (boot detection/surfacing).
const projectsResp = await (await fetch(fanoutSrv.url + '/api/projects')).json();
assert(Array.isArray(projectsResp.projects), '/api/projects returns projects array');

// --- Skill Layout output feed (recent_sess/recent_events on /api/projects/live-state) ---
// Real gm-plugkit .gm/next-step.md shape for project A so readLivePhaseState finds a live
// phase, plus a real plugkit instruction.served event on project A's own watcher.log so
// recentEventsForCwd's per-cwd activity index has something to surface. Project C (no
// next-step.md, no matching-cwd events beyond its earlier dispatch.end marker) exercises the
// zero-events/no-phase branch in the same request. The instruction body is deliberately >500
// chars -- readLivePhaseState previously hard-capped instruction_excerpt at body.slice(0, 500),
// silently clipping every real-world instruction (which routinely run several KB); this
// regression-tests that the fix actually serves the full body, not just a longer-but-still-
// truncated one.
const longInstructionBody = 'test instruction line.\n'.repeat(30); // 24 * 30 = 720 chars, > 500
fs.writeFileSync(path.join(projA.proj, '.gm', 'next-step.md'),
  '# Next step\n\nPhase: PLAN\nUpdated: ' + Date.now() + '\n\n---\n\n# PLAN\n\n' + longInstructionBody);
const sessMarker = 'cwd-test-sess-' + Date.now();
fs.appendFileSync(projA.logFp, `evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'instruction.served', sess: sessMarker, phase: 'PLAN', prd_pending: 2, cwd: projA.proj })}\n`);
// Give the fanout tailer a moment to ingest the freshly-appended line into store.events.
await new Promise(r => setTimeout(r, 500));

const liveStateResp = await (await fetch(fanoutSrv.url + '/api/projects/live-state')).json();
assert(Array.isArray(liveStateResp.projects), '/api/projects/live-state returns projects array');
const liveA = liveStateResp.projects.find(p => path.resolve(p.cwd) === projA.proj);
assert(liveA, 'project A present in live-state response');
assert.strictEqual(liveA.phase, 'PLAN', 'project A live phase read from next-step.md');
assert(liveA.instruction_excerpt.endsWith(longInstructionBody),
  `instruction_excerpt must contain the FULL untruncated body (got ${liveA.instruction_excerpt.length} chars, expected it to end with the ${longInstructionBody.length}-char body)`);
assert(liveA.instruction_excerpt.length > 500,
  `instruction_excerpt must exceed the old 500-char cap to prove it is no longer truncated (got ${liveA.instruction_excerpt.length})`);
assert(Array.isArray(liveA.recent_events), 'project A recent_events is an array');
assert(liveA.recent_events.some(n => n.kind === 'instruction' && n.phase === 'PLAN' && n.prd_pending === 2),
  `project A recent_events missing the instruction.served node (got ${JSON.stringify(liveA.recent_events)})`);
assert.strictEqual(liveA.recent_sess, sessMarker, 'project A recent_sess matches the session that produced the most recent event');
const liveC = liveStateResp.projects.find(p => path.resolve(p.cwd) === projC.proj);
assert(liveC, 'project C present in live-state response');
assert.strictEqual(liveC.recent_sess, null, 'project C (no sess-tagged events) has null recent_sess, not a crash');
assert.deepStrictEqual(liveC.recent_events, [], 'project C recent_events is an empty array, not undefined/null');

await fanoutSrv.close();
if (prevSpoolDirs === undefined) delete process.env.GM_SPOOL_DIRS; else process.env.GM_SPOOL_DIRS = prevSpoolDirs;
delete process.env.GM_FANOUT_REDISCOVER_MS;
fs.rmSync(fanoutRoot, { recursive: true, force: true });

await close();

// CLI information tiering: --help leads QUICK START -> DAILY -> DIAGNOSTICS; --schema carries tier fields.
const helpOut = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' }).stdout;
assert(helpOut.indexOf('QUICK START') > -1 && helpOut.indexOf('QUICK START') < helpOut.indexOf('DAILY') && helpOut.indexOf('DAILY') < helpOut.indexOf('DIAGNOSTICS'), 'help tier order');
const schemaOut = JSON.parse(spawnSync(process.execPath, ['src/cli.js', '--schema'], { encoding: 'utf8' }).stdout);
assert(schemaOut.subcommands.every(s => typeof s.tier === 'string'), 'schema subcommand tier');

console.log(`gmsniff OK — ${snap.total} events across ${days.length} days · live-feedback verified · multi-project fanout verified`);
