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
// REALISTIC live shape: no `sess` field, and the real instruction.served field names
// (prd_pending_count/mutables_pending_count, NOT prd_pending/mutables_pending). Live watcher.log
// events carry no sess at all, so an injected synthetic one would encode the very bug this
// asserts is fixed -- recent_events must be non-empty for a project identified only by
// (cwd, ts-ordering, daemon-boot epoch).
fs.appendFileSync(projA.logFp, `evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'instruction.served', phase: 'PLAN', prd_pending_count: 2, mutables_pending_count: 0, cwd: projA.proj })}\n`);
// Give the fanout tailer a moment to ingest the freshly-appended line into store.events.
await new Promise(r => setTimeout(r, 500));

// ?all=1: live-state hides idle/abandoned agents by DEFAULT (678 discovered projects on a real
// machine, a handful working), always reporting the hidden count. Tests assert over the whole
// discovered population, so they opt in explicitly.
const liveStateResp = await (await fetch(fanoutSrv.url + '/api/projects/live-state?all=1')).json();
assert(Array.isArray(liveStateResp.projects), '/api/projects/live-state returns projects array');
assert.strictEqual(liveStateResp.mode, 'list', 'live-state defaults to the light list payload');
assert.strictEqual(typeof liveStateResp.hidden, 'number', 'live-state reports how many projects the activity filter hid');
assert(liveStateResp.source && typeof liveStateResp.source.selected === 'string',
  'live-state carries source provenance so a total is never rendered unlabelled');
const liveA = liveStateResp.projects.find(p => path.resolve(p.cwd) === projA.proj);
assert(liveA, 'project A present in live-state response');
assert.strictEqual(liveA.phase, 'PLAN', 'project A live phase read from next-step.md');
// The light payload carries a bounded preview + length, never the multi-KB body.
assert.strictEqual(liveA.instruction_excerpt, undefined, 'list mode omits the full instruction body');
assert(liveA.instruction_length >= longInstructionBody.length,
  `instruction_length reports the FULL body size (got ${liveA.instruction_length}, expected >= ${longInstructionBody.length})`);
assert(liveA.instruction_truncated, 'preview is flagged truncated for a body this long');

// The full body remains available untruncated, via ?full=1 and via the drilldown route.
const liveFull = await (await fetch(fanoutSrv.url + '/api/projects/live-state?full=1&all=1')).json();
const liveAFull = liveFull.projects.find(p => path.resolve(p.cwd) === projA.proj);
assert(liveAFull.instruction_excerpt.endsWith(longInstructionBody),
  `full mode must serve the FULL untruncated body (got ${liveAFull.instruction_excerpt.length} chars)`);
assert(liveAFull.instruction_excerpt.length > 500,
  `full body must exceed the old 500-char cap (got ${liveAFull.instruction_excerpt.length})`);
const drill = await (await fetch(fanoutSrv.url + '/api/projects/instruction?cwd=' + encodeURIComponent(projA.proj))).json();
assert(drill.instruction_excerpt.endsWith(longInstructionBody), 'drilldown route serves the full instruction body');

// THE ACCEPTANCE CHECK for correlation: a project whose events carry no `sess` must still
// produce a non-empty output feed, keyed on the real correlation identity.
assert(Array.isArray(liveA.recent_events), 'project A recent_events is an array');
assert(liveA.recent_events.length > 0,
  'project A recent_events must be NON-EMPTY for sess-less live events (the correlation-key fix)');
assert(liveA.recent_events.some(n => n.kind === 'instruction' && n.phase === 'PLAN' && n.prd_pending_count === 2),
  `project A recent_events missing the instruction.served node with the REAL field names (got ${JSON.stringify(liveA.recent_events)})`);
assert(liveA.recent_correlation_kind && liveA.recent_correlation_kind !== 'sess',
  `correlation kind must be a real non-sess identity for live data (got ${liveA.recent_correlation_kind})`);
assert.strictEqual(typeof liveA.recent_total, 'number', 'recent_events cap is explicit in the payload');
const liveC = liveStateResp.projects.find(p => path.resolve(p.cwd) === projC.proj);
assert(liveC, 'project C present in live-state response');
assert(Array.isArray(liveC.recent_events), 'project C recent_events is an array, not undefined/null');

await fanoutSrv.close();
if (prevSpoolDirs === undefined) delete process.env.GM_SPOOL_DIRS; else process.env.GM_SPOOL_DIRS = prevSpoolDirs;
delete process.env.GM_FANOUT_REDISCOVER_MS;
fs.rmSync(fanoutRoot, { recursive: true, force: true });

// -- Formal verification: schema versioning, resource bounds, new monitoring endpoints --
assert.strictEqual(snap.schemaVersion, 'v1', 'snapshot carries schema version');
assert(typeof snap.evictedCount === 'number', 'snapshot has evictedCount');
assert(typeof snap.maxEvents === 'number', 'snapshot has maxEvents');
assert(snap.maxEvents > 0, 'maxEvents is positive');

const spoolQueue = await get('/api/spool-queue');
assert(Array.isArray(spoolQueue.queues), 'spool-queue has queues array');
assert.strictEqual(spoolQueue.schemaVersion, 'v1', 'spool-queue has schema version');

const watcherVersions = await get('/api/watcher-versions');
assert(Array.isArray(watcherVersions.projects), 'watcher-versions has projects array');
assert.strictEqual(watcherVersions.schemaVersion, 'v1', 'watcher-versions has schema version');

const instructionTiers = await get('/api/instruction-tiers');
assert(typeof instructionTiers.byTier === 'object', 'instruction-tiers has byTier object');
assert(typeof instructionTiers.byTier.vendored === 'number', 'byTier.vendored is a number');
assert(typeof instructionTiers.byTier['source-synced'] === 'number', 'byTier.source-synced is a number');
assert(typeof instructionTiers.byTier.default === 'number', 'byTier.default is a number');
assert.strictEqual(instructionTiers.schemaVersion, 'v1', 'instruction-tiers has schema version');

// Per-event schema version on a live SSE event
const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-schema-'));
const schemaDay = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.join(schemaDir, schemaDay), { recursive: true });
const schemaFile = path.join(schemaDir, schemaDay, 'plugkit.jsonl');
fs.writeFileSync(schemaFile, '');
const schemaSrv = await createServer({ logDir: schemaDir, port: 0 });
const schemaReceived = [];
await new Promise((resolve, reject) => {
  const req = http.get(schemaSrv.url + '/api/stream', res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let data = '';
        for (const l of frame.split('\n')) if (l.startsWith('data: ')) data += l.slice(6);
        if (data) { try { schemaReceived.push(JSON.parse(data)); } catch {} }
      }
    });
    res.on('error', reject);
  });
  req.on('error', reject);
  (async () => {
    await new Promise(r => setTimeout(r, 500));
    const marker = 'SCHEMA_TEST_' + Date.now();
    fs.appendFileSync(schemaFile, JSON.stringify({ ts: new Date().toISOString(), event: 'schema.test', pid: process.pid, marker }) + '\n');
    const dl = Date.now() + 3000;
    while (Date.now() < dl && !schemaReceived.some(e => e.marker === marker)) await new Promise(r => setTimeout(r, 100));
    const ev = schemaReceived.find(e => e.marker === marker);
    assert(ev, 'schema test event received via SSE');
    assert.strictEqual(ev._schema, 'v1', 'live SSE event carries _schema: v1');
    req.destroy();
    resolve();
  })().catch(reject);
});
await schemaSrv.close();
fs.rmSync(schemaDir, { recursive: true, force: true });

// -- Stuck-project detection --
const stuck = await get('/api/stuck-projects');
assert(Array.isArray(stuck), 'stuck-projects is array');

// -- Event throughput --
const throughput = await get('/api/throughput');
assert(typeof throughput.total === 'number', 'throughput.total is number');
assert(typeof throughput.rates === 'object', 'throughput.rates is object');
assert(typeof throughput.rates['1m'] === 'object', 'throughput has 1m window');
assert(typeof throughput.rates['1m'].perMinute === 'number', 'throughput 1m has perMinute');
assert.strictEqual(throughput.schemaVersion, 'v1', 'throughput has schema version');

// -- Memory store health --
const memHealth = await get('/api/memory-store-health');
assert(Array.isArray(memHealth.projects), 'memory-store-health has projects array');
assert.strictEqual(memHealth.schemaVersion, 'v1', 'memory-store-health has schema version');

// -- CodeInsight age --
const ciAge = await get('/api/codeinsight-age');
assert(Array.isArray(ciAge.projects), 'codeinsight-age has projects array');
assert.strictEqual(ciAge.schemaVersion, 'v1', 'codeinsight-age has schema version');

// -- Total parser: parseCodeInsight discriminated union --
import { parseCodeInsight } from './src/server.js';
const empty = parseCodeInsight('');
assert.strictEqual(empty.accepted, false, 'parseCodeInsight rejects empty string');
assert(typeof empty.reason === 'string', 'parseCodeInsight rejection has reason');
const malformed = parseCodeInsight('just some text\nno header here');
assert.strictEqual(malformed.accepted, false, 'parseCodeInsight rejects malformed input');
const valid = parseCodeInsight('# 10f 1.5kL 20fn 3cls cx2.5\n## Code Organization\nsrc/foo.js:100L');
assert.strictEqual(valid.accepted, true, 'parseCodeInsight accepts valid input');
assert.strictEqual(valid.value.summary.files, 10, 'parseCodeInsight parses file count');
assert.strictEqual(valid.value.summary.functions, 20, 'parseCodeInsight parses function count');
assert(Array.isArray(valid.value.entries), 'parseCodeInsight entries is array');

await close();

// CLI information tiering: --help leads QUICK START -> DAILY -> DIAGNOSTICS; --schema carries tier fields.
const helpOut = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' }).stdout;
assert(helpOut.indexOf('QUICK START') > -1 && helpOut.indexOf('QUICK START') < helpOut.indexOf('DAILY') && helpOut.indexOf('DAILY') < helpOut.indexOf('DIAGNOSTICS'), 'help tier order');
const schemaOut = JSON.parse(spawnSync(process.execPath, ['src/cli.js', '--schema'], { encoding: 'utf8' }).stdout);
assert(schemaOut.subcommands.every(s => typeof s.tier === 'string'), 'schema subcommand tier');

// --- watcher.log total-line parser, source priority, correlation identity, project state ---
// Real files on a real temp root; no mocks. Exercises the line classes that make up ~80% of a
// real watcher.log and were previously discarded silently, plus the source-selection polarity.
{
  const wl = await import('./src/watcher-log.js');
  const idx = await import('./src/index.js');
  const reg = await import('./src/registry.js');
  const corr = await import('./src/correlation.js');

  const parseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-parse-'));
  const pProj = path.join(parseRoot, 'proj');
  const pSpool = path.join(pProj, '.gm', 'exec-spool');
  fs.mkdirSync(pSpool, { recursive: true });
  const pLog = path.join(pSpool, '.watcher.log');
  fs.writeFileSync(pLog, [
    '--- watcher spawn 2026-07-27T10:00:00.000Z supervisor=999 reason=planned-restart ---',
    '[plugkit-wasm] plugkit v0.1.999 (wasm)',
    '[dispatch] -> verb=git_finalize task=7 body=1659b',
    `evt: ${JSON.stringify({ ts: 1785150000000, event: 'dispatch.end', verb: 'git_finalize', ms: 42 })}`,
    '[plugkit-wasm] stale lock (holder pid=4242 dead, age=5656ms); taking over',
    '[plugkit-wasm:warn] instruction::handle start body_len=740',
    '[retention] swept 4 out/ files older than 1h',
    '[plugkit-wasm] unimplemented WASI call: path_remove_directory args=3',
    '',
  ].join('\n'));

  const rep = wl.replayWatcherLogWithStats(pLog, pProj, 'v1');
  const byEvent = Object.fromEntries(rep.events.map(e => [e.event, e]));
  assert(byEvent['dispatch.start'], 'dispatch.start synthesized from [dispatch] -> line');
  assert.strictEqual(byEvent['dispatch.start'].verb, 'git_finalize', 'synthesized dispatch.start keeps verb');
  assert.strictEqual(byEvent['dispatch.start'].task, '7', 'synthesized dispatch.start keeps task');
  assert.strictEqual(byEvent['dispatch.start'].body_bytes, 1659, 'synthesized dispatch.start keeps body size');
  assert.strictEqual(byEvent['dispatch.start']._origin, 'line', 'synthesized events marked _origin=line');
  assert.strictEqual(byEvent['dispatch.end']._origin, 'evt', 'evt-sourced events marked _origin=evt');
  assert.strictEqual(rep.version, '0.1.999', 'served version recovered from wasm banner');
  assert.strictEqual(rep.epoch, '2026-07-27T10:00:00.000Z', 'watcher-spawn epoch extracted');
  assert.strictEqual(byEvent['lock.stale-takeover'].holder_pid, 4242, 'stale-lock takeover parsed');
  assert.strictEqual(byEvent['retention.swept'].swept, 4, 'retention sweep parsed');
  assert(byEvent['instruction.handle-start'], 'turn-entry boundary parsed');
  assert(rep.events.every(e => e._run === '2026-07-27T10:00:00.000Z'), 'every event tagged with its daemon-boot epoch');
  assert(rep.events.every(e => path.resolve(e.cwd) === path.resolve(pProj)), 'cwd attribution comes from the discovered project');
  // Coverage counters make the discard visible rather than silent.
  assert.strictEqual(rep.stats.runtime_lines, 1, 'runtime chatter counted, not silently dropped');
  assert(rep.stats.drop_ratio > 0 && rep.stats.drop_ratio < 1, 'drop_ratio reported');
  assert.strictEqual(rep.stats.unmodeled_ratio, 0, 'every crafted line matched a known shape');

  // Bounded replay: maxBytes truncates from the head and never yields a partial first line.
  const bounded = wl.replayWatcherLogWithStats(pLog, pProj, 'v1', { maxBytes: 120 });
  assert.strictEqual(bounded.truncated, true, 'bounded replay reports truncation');
  assert(bounded.stats.total < rep.stats.total, 'bounded replay reads fewer lines than full replay');

  // Correlation identity is honest: no sess in this data, so it must resolve to run, not invent one.
  const cov = corr.correlationCoverage(rep.events);
  assert.strictEqual(cov.best_kind, 'run', 'correlation falls back to daemon-boot epoch when sess is absent');
  assert.strictEqual(cov.has_true_session, false, 'correlation does not claim session fidelity it lacks');
  assert.strictEqual(cov.counts.sess, 0, 'no synthetic sess key is minted');
  assert.strictEqual(corr.correlationOf({ sess: 'real-sess' }).kind, 'sess', 'a real sess field still wins when present');
  // The session_id tier is gone because it could never match: gm's emit_event writes only
  // event/sess/ts onto an event, and session_id lives in .gm/turn-state.json (project state).
  assert.deepStrictEqual(corr.CORRELATION_KINDS, ['sess', 'run', 'cwd'], 'no rank tier that structurally cannot match');
  assert.strictEqual(corr.correlationOf({ session_id: 'x', cwd: 'C:/p', _run: 'r' }).kind, 'run',
    'an event carrying session_id is still grouped by run -- session_id is not an event field');
  assert.strictEqual(cov.dominant_kind, 'run', 'coverage reports what the grouping is actually worth, not its rarest strong id');

  // A second crafted log covering the parse classes added for the real shapes measured live:
  // both dispatch arrow generations, the supervisor spawn banner, ANSI-wrapped runtime lines,
  // update/stale-sweep/turn-state-failure/process-error lines, and the malformed-verb bug.
  const ESC = String.fromCharCode(27);
  const BS = String.fromCharCode(92);
  const p2Proj = path.join(parseRoot, 'proj2');
  fs.mkdirSync(path.join(p2Proj, '.gm', 'exec-spool'), { recursive: true });
  const p2Log = path.join(p2Proj, '.gm', 'exec-spool', '.watcher.log');
  fs.writeFileSync(p2Log, [
    '--- supervisor spawn 2026-07-27T11:00:00.000Z parent=555 ---',
    `evt: ${JSON.stringify({ ts: 1785160000000, event: 'instruction.served' })}`,
    '[dispatch] \u2192 verb=codesearch task=3 body=31b',
    '[dispatch] \u2190 verb=codesearch task=3 ms=122 out=44b',
    '[dispatch] -> verb=instruction task=4 body=2b',
    '[dispatch] <- verb=instruction task=4 ms=26 out=4221b',
    '[dispatch] -> verb=browser task=9 body=10b',
    `[dispatch] \u2192 verb=prd-resolve${BS}.gm${BS}exec-spool task=.status body=222b`,
    `[plugkit-wasm] error processing prd-resolve${BS}.gm${BS}exec-spool${BS}.status.json: ENOENT: no such file`,
    '[update] available: installed=2.0.1 latest=2.0.9',
    '[stale-sweep] auto-failed prd-resolve.json (age=90000ms)',
    'turn-state.json parse failed (missing field `phase` at line 1 column 2): backed up',
    '[retention] failed to sweep browser: EPERM: operation not permitted',
    `${ESC}[36m[plugkit-wasm:warn] recall::recall_hits start query_len=12${ESC}[0m`,
    '(node:1234) [DEP0190] DeprecationWarning: Passing args to a child process',
    '    at file:///C:/Users/user/.gm-tools/plugkit-wasm-wrapper.js:1:1',
    '',
  ].join('\n'));

  const rep2 = wl.replayWatcherLogWithStats(p2Log, p2Proj, 'v1');
  const ev2 = rep2.events;
  const dStarts = ev2.filter(e => e.event === 'dispatch.start');
  assert.strictEqual(dStarts.length, 4, 'both ASCII and Unicode dispatch arrows are parsed');
  assert(dStarts.some(e => e.verb === 'codesearch' && e.body_bytes === 31), 'Unicode-arrow dispatch keeps its fields');
  const dEnds = ev2.filter(e => e.event === 'dispatch.end' && e._origin === 'line');
  assert(dEnds.some(e => e.verb === 'codesearch' && e.ms === 122 && e.out_bytes === 44),
    'Unicode-arrow close carries both duration and response size');
  const byEvent2 = Object.fromEntries(ev2.map(e => [e.event, e]));
  assert.strictEqual(byEvent2['supervisor.spawn'].parent_pid, 555, 'supervisor spawn banner modeled');
  assert.strictEqual(byEvent2['update.available'].latest, '2.0.9', 'update banner carries installed+latest');
  assert.strictEqual(byEvent2['spool.stale-swept'].age_ms, 90000, 'stale-sweep auto-fail modeled');
  assert(byEvent2['turn-state.parse-failed'], 'turn-state deserialize failure modeled');
  assert(byEvent2['retention.failed'], 'a failed sweep is modeled distinctly from a successful one');
  assert(byEvent2['spool.process-error'], 'unprocessable spool request modeled');
  assert.strictEqual(rep2.stats.unmodeled_ratio, 0, 'every crafted line matched a known shape');
  assert(rep2.stats.hostnoise_lines >= 2, 'node host chatter is classified, not left unmodeled');
  assert(rep2.stats.runtime_lines >= 1, 'an ANSI-wrapped runtime line is still recognized as runtime');
  assert(rep2.stats.ignored < rep2.stats.modeled, 'ignored lines are reported apart from real signal');

  // Dispatch pairing: by task id, with in-flight starts and the upstream malformed-verb bug
  // reported as separate, non-overlapping counts.
  const pairing = rep2.dispatch;
  assert.strictEqual(pairing.paired, 2, 'starts pair to their ends by task id');
  assert.strictEqual(pairing.orphan_starts, 1, 'a start with no end is reported as in-flight');
  assert.strictEqual(pairing.malformed_verb_starts, 1, 'a path-shaped verb is excluded from pairing, counted separately');
  const cs = pairing.pairs.find(p => p.verb === 'codesearch');
  assert.deepStrictEqual([cs.ms, cs.body_bytes, cs.out_bytes], [122, 31, 44], 'a pair carries duration, request and response size');
  const verbStats = wl.dispatchVerbStats(pairing);
  assert(verbStats.some(v => v.verb === 'instruction' && v.out_bytes === 4221), 'per-verb response size aggregated');

  // Untimed head-region events: lines before the file's first evt record have no ts to inherit.
  const p3Proj = path.join(parseRoot, 'proj3');
  fs.mkdirSync(path.join(p3Proj, '.gm', 'exec-spool'), { recursive: true });
  const p3Log = path.join(p3Proj, '.gm', 'exec-spool', '.watcher.log');
  fs.writeFileSync(p3Log, [
    '[dispatch] -> verb=recall task=1 body=40b',
    '[retention] swept 2 out/ files older than 1h',
    `evt: ${JSON.stringify({ ts: 1785170000000, event: 'instruction.served' })}`,
    '',
  ].join('\n'));
  const rep3 = wl.replayWatcherLogWithStats(p3Log, p3Proj, 'v1');
  assert.strictEqual(rep3.events.filter(e => !e.ts).length, 0, 'no event is left without a ts');
  const backfilled = rep3.events.filter(e => e._ts_source === 'backfill');
  assert.strictEqual(backfilled.length, 2, 'head-region events are backfilled from the first following ts');
  assert(backfilled.every(e => e._untimed === true), 'a backfilled ts is still flagged as not upstream-supplied');
  const expectDay = new Date(1785170000000).toISOString().slice(0, 10);
  assert(backfilled.every(e => e._day === expectDay), 'backfilled events get a real day bucket');
  const st3 = idx.sourceStaleness(rep3.events);
  assert.strictEqual(st3.untimed, 0, 'staleness reports how many events no time view can see');
  // A missing argument is a programming error, not evidence that the source is stale.
  assert.throws(() => idx.sourceStaleness(), /requires an events array/, 'sourceStaleness cannot invent a stale verdict from no input');
  assert.strictEqual(idx.sourceStaleness([]).stale, true, 'a genuinely empty set is still honestly stale');

  // Source priority: spool is read even though a non-empty gm-log dir exists.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-legacy-'));
  fs.mkdirSync(path.join(legacyDir, '2026-05-11'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, '2026-05-11', 'plugkit.jsonl'),
    `${JSON.stringify({ ts: 1747000000000, event: 'ancient.event' })}\n`);
  const prevSpool = process.env.GM_SPOOL_DIRS;
  process.env.GM_SPOOL_DIRS = pProj;
  const audited = idx.replayAllAudited(legacyDir);
  assert.strictEqual(audited.source, 'spool', 'live spool is the default source even when a legacy archive exists');
  assert.strictEqual(audited.archive_used, false, 'legacy archive is not blended into the live stream');
  assert(audited.events.every(e => e.event !== 'ancient.event'), 'archive events never leak into the default read');
  assert.strictEqual(audited.sources.gm_log.available, true, 'archive availability is still reported');
  const archived = idx.replayAllAudited(legacyDir, { archive: true });
  assert.strictEqual(archived.source, 'gm-log', 'archive is reachable behind an explicit opt-in');
  assert(archived.events.some(e => e.event === 'ancient.event'), 'archive opt-in actually reads the archive');
  assert(archived.staleness.stale === true, 'a years-old archive is reported stale');
  assert(archived.warnings.length > 0, 'stale source selection emits a loud warning');
  if (prevSpool === undefined) delete process.env.GM_SPOOL_DIRS; else process.env.GM_SPOOL_DIRS = prevSpool;

  // createServer-level source selection. The layer above replayAllAudited had its OWN inversion:
  // "explicit" was defined as `logDir !== undefined`, and src/cli.js passes the resolved
  // DEFAULT_LOG_DIR unconditionally, so every default `gmsniff gui` launch scored as an explicit
  // archive request and served 958,616 dead gm-log events with the live spool unused. The
  // replayAllAudited assertions above all still passed while that was broken, so the contract is
  // pinned here at the boundary where it actually failed: a default logDir is NOT explicit, while
  // an operator-named non-default path still wins (the behavior test.js's own live server needs).
  const defaultSrv = await createServer({ logDir: DEFAULT_LOG_DIR, port: 0 });
  assert.strictEqual(defaultSrv.store.explicitLogDir, false,
    'passing the resolved DEFAULT_LOG_DIR is NOT an explicit source request');
  assert.strictEqual(defaultSrv.store.source.archive_used, false,
    'a default-logDir launch never loads the legacy archive');
  assert.strictEqual(defaultSrv.store.source.selected, 'spool',
    'a default-logDir launch selects the live spool');
  assert.strictEqual(defaultSrv.store.source.explicit_reason, null,
    'explicit_reason is null when nothing was explicitly named');
  await defaultSrv.close();

  // The other half: a genuinely non-default path is still honored end-to-end.
  const namedSrv = await createServer({ logDir: legacyDir, port: 0 });
  assert.strictEqual(namedSrv.store.explicitLogDir, true,
    'an operator-named non-default logDir is explicit');
  assert.strictEqual(path.resolve(namedSrv.store.source.log_dir), path.resolve(legacyDir),
    'the named tree is the one actually loaded');
  assert.strictEqual(namedSrv.store.source.explicit_reason, 'caller-supplied non-default logDir',
    'explicit_reason names which input made it explicit');
  assert(namedSrv.store.source.total_before_window >= 1,
    'the explicitly named tree is actually read');
  await namedSrv.close();

  // Bounded + honestly-absent .gm YAML row stores. Two failures, both measured live:
  // spoint's prd.yml (2.1MB / 966 rows) was parsed AND serialized whole on every request, and
  // readPrd returns {mtimeMs:null, rows:[]} for BOTH a missing prd.yml (C:/dev/gm has none) and
  // an empty one -- so a client could not tell "no PRD" from "PRD with nothing pending".
  const yamlRowsVia = async (srv, cwd, route, extra = '') => {
    const r = await fetch(`${srv.url}/api/${route}?cwd=${encodeURIComponent(cwd)}${extra}`);
    assert.strictEqual(r.status, 200, `/api/${route} → ${r.status}`);
    return r.json();
  };
  const yamlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-yaml-'));
  const yProj = path.join(yamlRoot, 'proj');
  fs.mkdirSync(path.join(yProj, '.gm', 'exec-spool'), { recursive: true });
  fs.writeFileSync(path.join(yProj, '.gm', 'exec-spool', '.watcher.log'),
    `evt: ${JSON.stringify({ ts: new Date().toISOString(), event: 'instruction.served', cwd: yProj, phase: 'PLAN' })}\n`);
  const manyRows = Array.from({ length: 40 }, (_, i) => `- id: row-${i}\n  status: pending\n  text: r${i}\n`).join('');
  fs.writeFileSync(path.join(yProj, '.gm', 'prd.yml'), manyRows);
  // Set BEFORE createServer so the temp project is in the discovered registry that
  // resolveScopedCwd allowlists; an out-of-registry cwd is (correctly) rejected with 403.
  const prevYamlSpool = process.env.GM_SPOOL_DIRS;
  process.env.GM_SPOOL_DIRS = yProj;
  const yamlSrv = await createServer({ logDir: DEFAULT_LOG_DIR, port: 0 });
  // Absence is distinguishable from emptiness: mutables.yml was never written above.
  const r1 = await yamlRowsVia(yamlSrv, yProj, 'mutables');
  const r2 = await yamlRowsVia(yamlSrv, yProj, 'prd');
  assert.strictEqual(r1.present, false, 'a missing mutables.yml reports present:false');
  assert.strictEqual(r2.present, true, 'an existing prd.yml reports present:true');
  assert.deepStrictEqual([r1.rows.length, r2.total], [0, 40], 'absent store is empty, present store reports its true total');
  assert.strictEqual(typeof r2.file_bytes, 'number', 'parse cost is reported, not inferred');
  // Paging bound: an explicit oversized ?limit= cannot recreate the unbounded read.
  const capped = await yamlRowsVia(yamlSrv, yProj, 'prd', '&limit=10');
  assert.strictEqual(capped.returned, 10, 'rows are paged to the requested limit');
  assert.strictEqual(capped.total, 40, 'total still reports the whole store behind the window');
  assert.strictEqual(capped.truncated, true, 'a partial window is flagged, never passed off as complete');
  if (prevYamlSpool === undefined) delete process.env.GM_SPOOL_DIRS; else process.env.GM_SPOOL_DIRS = prevYamlSpool;
  await yamlSrv.close();
  fs.rmSync(yamlRoot, { recursive: true, force: true });

  // Per-project liveness must ignore the shared-daemon heartbeat, which ticks for every project
  // on the machine simultaneously (measured: gmsniff 281ms, spoint 131ms, casey 210ms and test
  // 258ms all at once, while casey's real work was 2.2 hours cold). A project whose OWN signals
  // -- watcher.log mtime, turn-summary ts, turn-state ts -- are all old must read as inactive no
  // matter how fresh that heartbeat is. Every per-project signal is backdated here; only the
  // heartbeat is current.
  const coldMs = Date.now() - (48 * 3600 * 1000);
  fs.writeFileSync(path.join(pSpool, '.status.json'),
    JSON.stringify({ pid: process.pid, ts: Date.now(), daemon: true, shared_process: true, runtime: 'agentplug' }));
  fs.writeFileSync(path.join(pProj, '.gm', 'turn-state.json'),
    JSON.stringify({ phase: 'VERIFY', session_id: null, last_skill: 'gm-verify', updated_at_ms: coldMs }));
  fs.utimesSync(pLog, new Date(coldMs), new Date(coldMs));
  const liveness = reg.readProjectLiveness(pProj);
  assert.strictEqual(liveness.active, false, 'a fresh shared-daemon heartbeat does not make a cold project active');
  assert(liveness.heartbeat_age_ms < 60000, 'heartbeat age is still reported for diagnostics');
  assert(liveness.last_activity_age_ms > 3600000, 'activity age comes from real per-project signals');
  // ...and a project whose own log really is fresh must read active through the same path.
  fs.utimesSync(pLog, new Date(), new Date());
  assert.strictEqual(reg.readProjectLiveness(pProj).active, true, 'a genuinely fresh watcher.log marks the project active');

  // turn-state.json is the primary phase source; next-step.md prose is the fallback.
  const ts0 = reg.readTurnState(pProj);
  assert.strictEqual(ts0.phase, 'VERIFY', 'turn-state.json phase read');
  fs.writeFileSync(path.join(pProj, '.gm', 'next-step.md'),
    `# Next step\n\nPhase: PLAN\nUpdated: ${Date.now()}\n\n---\n\n# PLAN\n\nbody\n`);
  const phaseState = reg.readLivePhaseState(pProj);
  assert.strictEqual(phaseState.phase, 'VERIFY', 'turn-state.json wins over next-step.md prose');
  assert.strictEqual(phaseState.phase_source, 'turn-state.json', 'phase source is reported');
  assert.strictEqual(phaseState.prose_phase, 'PLAN', 'prose phase retained alongside');
  assert.strictEqual(phaseState.phase_divergence, true, 'mid-transition divergence surfaced, not hidden');

  // Legacy phaseless turn-state.json must not be mistaken for a null-phase project.
  const legacyProj = path.join(parseRoot, 'legacy-shape');
  fs.mkdirSync(path.join(legacyProj, '.gm'), { recursive: true });
  fs.writeFileSync(path.join(legacyProj, '.gm', 'turn-state.json'), JSON.stringify({ turnId: 1778877945946, firstToolFired: false }));
  const legacyTs = reg.readTurnState(legacyProj);
  assert.strictEqual(legacyTs.legacy_shape, true, 'legacy phaseless turn-state.json flagged');
  assert.strictEqual(legacyTs.phase, null, 'legacy shape reports no phase rather than guessing');

  // Marker files that carry live state.
  fs.writeFileSync(path.join(pSpool, '.codeinsight-digest'), 'v3:296bc62dce39fec4:files=28');
  fs.writeFileSync(path.join(pSpool, '.last-gate-fired.json'), JSON.stringify({ key: 'gates/long-gap-no-instruction', ts: 1784888665055 }));
  fs.writeFileSync(path.join(pProj, '.gm', 'last-dispatch-ts'), '1785151839332');
  fs.writeFileSync(path.join(pProj, '.gm', 'claim-audit-fired'), 'clean');
  const markers = reg.readProjectMarkers(pProj);
  assert.strictEqual(markers.codeinsight_digest.files, 28, 'codeinsight digest parsed');
  assert.strictEqual(markers.codeinsight_digest.hash, '296bc62dce39fec4', 'codeinsight digest hash parsed');
  assert.strictEqual(markers.last_gate.key, 'gates/long-gap-no-instruction', 'last-gate-fired marker read');
  assert.strictEqual(markers.last_dispatch_ts, 1785151839332, 'last-dispatch-ts read');
  assert.strictEqual(markers.claim_audit_result, 'clean', 'claim-audit marker body read');

  // runtime key collision: .status.json runtime is the host, .turn-summary.json runtime is the guest.
  fs.writeFileSync(path.join(pSpool, '.turn-summary.json'),
    JSON.stringify({ phase: 'PLAN', ts: Date.now(), runtime: 'native', prd_pending_count: 3, mutables_pending_count: 1, long_gap_threshold_ms: 300000 }));
  const summary = reg.readTurnSummary(pProj);
  const wstatus = reg.readWatcherStatus(pProj);
  assert.strictEqual(summary.guest_runtime, 'native', 'turn-summary runtime surfaced as guest_runtime');
  assert.strictEqual(wstatus.host_runtime, 'agentplug', 'status.json runtime surfaced as host_runtime');
  assert.notStrictEqual(summary.guest_runtime, wstatus.host_runtime, 'the two runtime keys are never merged');
  assert.strictEqual(summary.prd_pending_count, 3, 'instruction.served-style *_count fields consumed');
  assert.strictEqual(wstatus.version, null, 'absent version is an honest null, not fabricated');

  // rewriteRow preserves a legacy `- title:` boundary instead of reshaping it to `- id:`.
  const legacyYaml = '- title: Some legacy row\n  id: legacy-1\n  status: pending\n- id: normal-1\n  status: pending\n';
  const rewritten = reg.rewriteRow(legacyYaml, 'legacy-1', { status: 'done' });
  assert(rewritten.startsWith('- title:'), 'rewriteRow keeps the original row boundary field');
  assert(rewritten.includes('status: done'), 'rewriteRow applies the requested field change');
  assert(rewritten.includes('- id: normal-1\n  status: pending'), 'rewriteRow leaves other rows byte-identical');

  // Verb allowlist: new runner verbs recognized, retired verbs recognized but not usable.
  assert.strictEqual(reg.isKnownVerb('plugin-refresh'), true, 'runner verb plugin-refresh recognized');
  assert.strictEqual(reg.isKnownVerb('background-convert'), true, 'runner verb background-convert recognized');
  assert.strictEqual(reg.isUsableVerb('learn'), false, 'retired verb learn is not usable');
  assert.strictEqual(reg.isUsableVerb('wait'), false, 'retired verb wait is not usable');
  assert.strictEqual(reg.isKnownVerb('learn'), true, 'retired verb is still a recognized dispatch target');

  // Subsystem universe grows from real observed tags rather than a closed hardcode.
  assert(idx.SUBSYSTEMS.includes('rs_learn'), 'rs_learn restored to the subsystem seed');
  idx.deriveSubsystems([{ _sub: 'brand_new_tag' }]);
  assert(idx.observedSubsystems().includes('brand_new_tag'), 'a genuinely new tag is observed at runtime');

  // Status vocabulary is policy, not a hardcode.
  const prevClosed = process.env.GM_PRD_CLOSED_STATUSES;
  process.env.GM_PRD_CLOSED_STATUSES = 'shipped';
  assert(reg.prdClosedStatuses().includes('shipped'), 'closed-status vocabulary is configurable');
  if (prevClosed === undefined) delete process.env.GM_PRD_CLOSED_STATUSES; else process.env.GM_PRD_CLOSED_STATUSES = prevClosed;

  fs.rmSync(parseRoot, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

console.log(`gmsniff OK — ${snap.total} events across ${days.length} days · live-feedback verified · multi-project fanout verified · formal-spec verified · stuck-state+throughput+memory-health+codeinsight-age verified · total-parser verified · watcher-log-total-parse+source-priority+correlation+project-state verified`);
