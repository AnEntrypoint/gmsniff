import assert from 'assert';
import { createServer } from './src/server.js';
import { DEFAULT_LOG_DIR } from './src/index.js';
import { readPrd, readMutables, readPrdMutablesState, parseYamlRows } from './src/registry.js';
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

// A watcher.log line's own `cwd` field is attacker-controlled: any project can write a line
// claiming another project's cwd, so attribution must come from the discovered path instead.
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
let projC;
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
    const markerOnLineClaimingAnotherProjectsCwd = 'FANOUT_SPOOF_' + Date.now();
    fs.appendFileSync(projB.logFp, `evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'dispatch.end', marker: markerOnLineClaimingAnotherProjectsCwd, cwd: projA.proj })}\n`);

    const dl = Date.now() + 6000;
    while (Date.now() < dl && !(fanoutReceived.some(e => e.marker === markerA) && fanoutReceived.some(e => e.marker === markerB) && fanoutReceived.some(e => e.marker === markerOnLineClaimingAnotherProjectsCwd))) {
      await new Promise(r => setTimeout(r, 100));
    }
    const evA = fanoutReceived.find(e => e.marker === markerA);
    const evB = fanoutReceived.find(e => e.marker === markerB);
    const evSpoof = fanoutReceived.find(e => e.marker === markerOnLineClaimingAnotherProjectsCwd);
    assert(evA, `project A event not received (got ${fanoutReceived.length} events)`);
    assert(evB, `project B event not received (got ${fanoutReceived.length} events)`);
    assert.strictEqual(path.resolve(evA.cwd), projA.proj, 'project A event cwd attribution');
    assert.strictEqual(path.resolve(evB.cwd), projB.proj, 'project B event cwd attribution');
    assert(evSpoof, 'spoofed-cwd event not received');
    assert.strictEqual(path.resolve(evSpoof.cwd), projB.proj, 'spoofed cwd field must be overridden by the real discovered project B cwd, not the claimed project A cwd');

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

const projectsResp = await (await fetch(fanoutSrv.url + '/api/projects')).json();
assert(Array.isArray(projectsResp.projects), '/api/projects returns projects array');

// Over 500 chars on purpose: instruction_excerpt was once hard-capped at body.slice(0, 500),
// silently clipping every real instruction (they run several KB).
const OLD_INSTRUCTION_EXCERPT_CAP = 500;
const longInstructionBody = 'test instruction line.\n'.repeat(30);
assert(longInstructionBody.length > OLD_INSTRUCTION_EXCERPT_CAP, 'fixture body must exceed the old cap to exercise it');
fs.writeFileSync(path.join(projA.proj, '.gm', 'next-step.md'),
  '# Next step\n\nPhase: PLAN\nUpdated: ' + Date.now() + '\n\n---\n\n# PLAN\n\n' + longInstructionBody);
// Deliberately carries no `sess`: live watcher.log events never do, so injecting a synthetic one
// would hide the very bug this asserts is fixed.
fs.appendFileSync(projA.logFp, `evt: ${JSON.stringify({ ts: Date.now(), sub: 'plugkit', event: 'instruction.served', phase: 'PLAN', prd_pending_count: 2, mutables_pending_count: 0, cwd: projA.proj })}\n`);
await new Promise(r => setTimeout(r, 500));

// ?all=1 opts out of the default activity filter. Measured on a real machine: 678 discovered
// projects, a handful actually working -- so the default hides most of them.
const liveStateResp = await (await fetch(fanoutSrv.url + '/api/projects/live-state?all=1')).json();
assert(Array.isArray(liveStateResp.projects), '/api/projects/live-state returns projects array');
assert.strictEqual(liveStateResp.mode, 'list', 'live-state defaults to the light list payload');
assert.strictEqual(typeof liveStateResp.hidden, 'number', 'live-state reports how many projects the activity filter hid');
assert(liveStateResp.source && typeof liveStateResp.source.selected === 'string',
  'live-state carries source provenance so a total is never rendered unlabelled');
const liveA = liveStateResp.projects.find(p => path.resolve(p.cwd) === projA.proj);
assert(liveA, 'project A present in live-state response');
assert.strictEqual(liveA.phase, 'PLAN', 'project A live phase read from next-step.md');
assert.strictEqual(liveA.instruction_excerpt, undefined, 'list mode omits the full instruction body');
assert(liveA.instruction_length >= longInstructionBody.length,
  `instruction_length reports the FULL body size (got ${liveA.instruction_length}, expected >= ${longInstructionBody.length})`);
assert(liveA.instruction_truncated, 'preview is flagged truncated for a body this long');

const liveFull = await (await fetch(fanoutSrv.url + '/api/projects/live-state?full=1&all=1')).json();
const liveAFull = liveFull.projects.find(p => path.resolve(p.cwd) === projA.proj);
assert(liveAFull.instruction_excerpt.endsWith(longInstructionBody),
  `full mode must serve the FULL untruncated body (got ${liveAFull.instruction_excerpt.length} chars)`);
assert(liveAFull.instruction_excerpt.length > OLD_INSTRUCTION_EXCERPT_CAP,
  `full body must exceed the old ${OLD_INSTRUCTION_EXCERPT_CAP}-char cap (got ${liveAFull.instruction_excerpt.length})`);
const drill = await (await fetch(fanoutSrv.url + '/api/projects/instruction?cwd=' + encodeURIComponent(projA.proj))).json();
assert(drill.instruction_excerpt.endsWith(longInstructionBody), 'drilldown route serves the full instruction body');

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

const signals = await get('/api/project-signals');
assert(Array.isArray(signals), 'project-signals is array');
const legacyStuck = await get('/api/stuck-projects');
assert(Array.isArray(legacyStuck), 'stuck-projects (former name) still resolves');
if (signals.length) {
  const s = signals[0];
  for (const k of ['cwd', 'name', 'activity', 'prd_pending', 'gates_failing']) {
    assert(k in s, `project-signals row carries ${k}`);
  }
  assert(!('severity' in s), 'project-signals attaches no severity verdict');
  assert(!('issues' in s), 'project-signals attaches no issues verdict');
}

const throughput = await get('/api/throughput');
assert(typeof throughput.total === 'number', 'throughput.total is number');
assert(typeof throughput.rates === 'object', 'throughput.rates is object');
assert(typeof throughput.rates['1m'] === 'object', 'throughput has 1m window');
assert(typeof throughput.rates['1m'].perMinute === 'number', 'throughput 1m has perMinute');
assert.strictEqual(throughput.schemaVersion, 'v1', 'throughput has schema version');

const memHealth = await get('/api/memory-store-health');
assert(Array.isArray(memHealth.projects), 'memory-store-health has projects array');
assert.strictEqual(memHealth.schemaVersion, 'v1', 'memory-store-health has schema version');

const ciAge = await get('/api/codeinsight-age');
assert(Array.isArray(ciAge.projects), 'codeinsight-age has projects array');
assert.strictEqual(ciAge.schemaVersion, 'v1', 'codeinsight-age has schema version');

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

const helpOut = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' }).stdout;
assert(helpOut.indexOf('QUICK START') > -1 && helpOut.indexOf('QUICK START') < helpOut.indexOf('DAILY') && helpOut.indexOf('DAILY') < helpOut.indexOf('DIAGNOSTICS'), 'help tier order');
const schemaOut = JSON.parse(spawnSync(process.execPath, ['src/cli.js', '--schema'], { encoding: 'utf8' }).stdout);
assert(schemaOut.subcommands.every(s => typeof s.tier === 'string'), 'schema subcommand tier');

// Measured: the structured-text line classes exercised below make up ~80% of a real
// watcher.log, and were previously discarded silently.
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
  assert.strictEqual(rep.stats.runtime_lines, 1, 'runtime chatter counted, not silently dropped');
  assert(rep.stats.drop_ratio > 0 && rep.stats.drop_ratio < 1, 'drop_ratio reported');
  assert.strictEqual(rep.stats.unmodeled_ratio, 0, 'every crafted line matched a known shape');

  const bounded = wl.replayWatcherLogWithStats(pLog, pProj, 'v1', { maxBytes: 120 });
  assert.strictEqual(bounded.truncated, true, 'bounded replay reports truncation');
  assert(bounded.stats.total < rep.stats.total, 'bounded replay reads fewer lines than full replay');

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

  const pairing = rep2.dispatch;
  assert.strictEqual(pairing.paired, 2, 'starts pair to their ends by task id');
  assert.strictEqual(pairing.orphan_starts, 1, 'a start with no end is reported as in-flight');
  assert.strictEqual(pairing.malformed_verb_starts, 1, 'a path-shaped verb is excluded from pairing, counted separately');
  const cs = pairing.pairs.find(p => p.verb === 'codesearch');
  assert.deepStrictEqual([cs.ms, cs.body_bytes, cs.out_bytes], [122, 31, 44], 'a pair carries duration, request and response size');
  const verbStats = wl.dispatchVerbStats(pairing);
  assert(verbStats.some(v => v.verb === 'instruction' && v.out_bytes === 4221), 'per-verb response size aggregated');

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
  assert.throws(() => idx.sourceStaleness(), /requires an events array/, 'sourceStaleness cannot invent a stale verdict from no input');
  assert.strictEqual(idx.sourceStaleness([]).stale, true, 'a genuinely empty set is still honestly stale');

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

  // Regression: "explicit" was once defined as `logDir !== undefined`, and src/cli.js passes the
  // resolved DEFAULT_LOG_DIR unconditionally -- so every default `gmsniff gui` launch scored as an
  // explicit archive request and served 958,616 dead gm-log events with the live spool unused.
  // Every replayAllAudited assertion above still passed while that was broken, so the contract is
  // pinned here, at the boundary where it actually failed.
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

  // Two failures, both measured live: spoint's prd.yml (2.1MB / 966 rows) was parsed AND
  // serialized whole on every request, and readPrd returned {mtimeMs:null, rows:[]} for BOTH a
  // missing prd.yml (C:/dev/gm has none) and an empty one.
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
  const r1 = await yamlRowsVia(yamlSrv, yProj, 'mutables');
  const r2 = await yamlRowsVia(yamlSrv, yProj, 'prd');
  assert.strictEqual(r1.present, false, 'a missing mutables.yml reports present:false');
  assert.strictEqual(r2.present, true, 'an existing prd.yml reports present:true');
  assert.deepStrictEqual([r1.rows.length, r2.total], [0, 40], 'absent store is empty, present store reports its true total');
  assert.strictEqual(typeof r2.file_bytes, 'number', 'parse cost is reported, not inferred');
  const capped = await yamlRowsVia(yamlSrv, yProj, 'prd', '&limit=10');
  assert.strictEqual(capped.returned, 10, 'rows are paged to the requested limit');
  assert.strictEqual(capped.total, 40, 'total still reports the whole store behind the window');
  assert.strictEqual(capped.truncated, true, 'a partial window is flagged, never passed off as complete');
  if (prevYamlSpool === undefined) delete process.env.GM_SPOOL_DIRS; else process.env.GM_SPOOL_DIRS = prevYamlSpool;
  await yamlSrv.close();

  // The same distinction at the MODULE level: server.js's yamlRowsPayload had to re-stat the file
  // to recover `present`, so every other caller of readPrd/readMutables stayed unable to tell a
  // project with no PRD from one whose PRD is empty.
  const emptyProj = path.join(yamlRoot, 'empty-store');
  fs.mkdirSync(path.join(emptyProj, '.gm'), { recursive: true });
  fs.writeFileSync(path.join(emptyProj, '.gm', 'prd.yml'), '');
  const absentPrd = readPrd(path.join(yamlRoot, 'no-such-project'));
  const emptyPrd = readPrd(emptyProj);
  assert.strictEqual(absentPrd.present, false, 'a project with no prd.yml reports present:false');
  assert.strictEqual(emptyPrd.present, true, 'a project with an empty prd.yml reports present:true');
  assert.deepStrictEqual([absentPrd.rows.length, emptyPrd.rows.length], [0, 0],
    'both states are rows:[] -- which is exactly why `present` has to carry the distinction');
  assert.deepStrictEqual([absentPrd.bytes, emptyPrd.bytes], [null, 0],
    'absent has no byte count; empty has a real one of zero');
  assert.strictEqual(readMutables(path.join(yamlRoot, 'no-such-project')).present, false,
    'readMutables carries the same absence contract as readPrd');

  // Measured against ../gm's live mutables.yml: 259 rows, of which only 218 open with `- id:`.
  // readPrdMutablesState counted with its own split(/^- id:/m) rather than the parseYamlRows
  // boundary rule, silently losing the other 41 rows and never seeing their status.
  const boundaryProj = path.join(yamlRoot, 'legacy-boundary');
  fs.mkdirSync(path.join(boundaryProj, '.gm'), { recursive: true });
  fs.writeFileSync(path.join(boundaryProj, '.gm', 'mutables.yml'),
    '- id: normal-row\n  status: witnessed\n  claim: c1\n'
    + '- mutable_id: legacy-open\n  status: unknown\n  claim: c2\n'
    + '- subject: legacy-closed\n  status: witnessed\n  claim: c3\n');
  fs.writeFileSync(path.join(boundaryProj, '.gm', 'prd.yml'),
    '- id: p1\n  status: done\n  text: t1\n'
    + '- title: legacy-pending\n  status: pending\n  text: t2\n');
  const bState = readPrdMutablesState(boundaryProj);
  assert.strictEqual(bState.mut_total, 3, 'rows with a legacy boundary key are counted, not dropped');
  assert.strictEqual(bState.mut_unknown, 1, 'an OPEN mutable behind a legacy boundary key is visible');
  assert.strictEqual(bState.prd_total, 2, 'the same boundary rule applies to prd.yml');
  assert.strictEqual(bState.prd_pending, 1, 'a PENDING prd row behind a legacy boundary key is visible');
  assert.strictEqual(bState.mut_total, readMutables(boundaryProj).rows.length,
    'readPrdMutablesState and readMutables report the same row count');
  assert.strictEqual(bState.prd_total, readPrd(boundaryProj).rows.length,
    'readPrdMutablesState and readPrd report the same row count');
  // The row below has no `status:` field, only a `status: done` sitting inside its free text --
  // the case the old raw-text regex genuinely got wrong by closing the row.
  const quotedProj = path.join(yamlRoot, 'quoted-status');
  fs.mkdirSync(path.join(quotedProj, '.gm'), { recursive: true });
  fs.writeFileSync(path.join(quotedProj, '.gm', 'prd.yml'),
    "- id: q1\n  text: 'note: status: done was claimed but never witnessed'\n");
  assert.strictEqual(readPrdMutablesState(quotedProj).prd_pending, 1,
    'a closed-status word inside free text does not close a row that has no status of its own');
  fs.rmSync(yamlRoot, { recursive: true, force: true });

  // Measured: the shared daemon's heartbeat ticked for gmsniff 281ms, spoint 131ms, casey 210ms
  // and test 258ms all at once, while casey's real work was 2.2 hours cold. Every per-project
  // signal is backdated below; only the heartbeat is current.
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
  fs.utimesSync(pLog, new Date(), new Date());
  assert.strictEqual(reg.readProjectLiveness(pProj).active, true, 'a genuinely fresh watcher.log marks the project active');

  const ts0 = reg.readTurnState(pProj);
  assert.strictEqual(ts0.phase, 'VERIFY', 'turn-state.json phase read');
  fs.writeFileSync(path.join(pProj, '.gm', 'next-step.md'),
    `# Next step\n\nPhase: PLAN\nUpdated: ${Date.now()}\n\n---\n\n# PLAN\n\nbody\n`);
  const phaseState = reg.readLivePhaseState(pProj);
  assert.strictEqual(phaseState.phase, 'VERIFY', 'turn-state.json wins over next-step.md prose');
  assert.strictEqual(phaseState.phase_source, 'turn-state.json', 'phase source is reported');
  assert.strictEqual(phaseState.prose_phase, 'PLAN', 'prose phase retained alongside');
  assert.strictEqual(phaseState.phase_divergence, true, 'mid-transition divergence surfaced, not hidden');

  const legacyProj = path.join(parseRoot, 'legacy-shape');
  fs.mkdirSync(path.join(legacyProj, '.gm'), { recursive: true });
  fs.writeFileSync(path.join(legacyProj, '.gm', 'turn-state.json'), JSON.stringify({ turnId: 1778877945946, firstToolFired: false }));
  const legacyTs = reg.readTurnState(legacyProj);
  assert.strictEqual(legacyTs.legacy_shape, true, 'legacy phaseless turn-state.json flagged');
  assert.strictEqual(legacyTs.phase, null, 'legacy shape reports no phase rather than guessing');

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

  fs.writeFileSync(path.join(pSpool, '.turn-summary.json'),
    JSON.stringify({ phase: 'PLAN', ts: Date.now(), runtime: 'native', prd_pending_count: 3, mutables_pending_count: 1, long_gap_threshold_ms: 300000 }));
  const summary = reg.readTurnSummary(pProj);
  const wstatus = reg.readWatcherStatus(pProj);
  assert.strictEqual(summary.guest_runtime, 'native', 'turn-summary runtime surfaced as guest_runtime');
  assert.strictEqual(wstatus.host_runtime, 'agentplug', 'status.json runtime surfaced as host_runtime');
  assert.notStrictEqual(summary.guest_runtime, wstatus.host_runtime, 'the two runtime keys are never merged');
  assert.strictEqual(summary.prd_pending_count, 3, 'instruction.served-style *_count fields consumed');
  assert.strictEqual(wstatus.version, null, 'absent version is an honest null, not fabricated');

  const legacyYaml = '- title: Some legacy row\n  id: legacy-1\n  status: pending\n- id: normal-1\n  status: pending\n';
  const rewritten = reg.rewriteRow(legacyYaml, 'legacy-1', { status: 'done' });
  assert(rewritten.startsWith('- title:'), 'rewriteRow keeps the original row boundary field');
  assert(rewritten.includes('status: done'), 'rewriteRow applies the requested field change');
  assert(rewritten.includes('- id: normal-1\n  status: pending'), 'rewriteRow leaves other rows byte-identical');

  assert.strictEqual(reg.isKnownVerb('plugin-refresh'), true, 'runner verb plugin-refresh recognized');
  assert.strictEqual(reg.isKnownVerb('background-convert'), true, 'runner verb background-convert recognized');
  assert.strictEqual(reg.isUsableVerb('learn'), false, 'retired verb learn is not usable');
  assert.strictEqual(reg.isUsableVerb('wait'), false, 'retired verb wait is not usable');
  assert.strictEqual(reg.isKnownVerb('learn'), true, 'retired verb is still a recognized dispatch target');

  assert(idx.SUBSYSTEMS.includes('rs_learn'), 'rs_learn restored to the subsystem seed');
  idx.deriveSubsystems([{ _sub: 'brand_new_tag' }]);
  assert(idx.observedSubsystems().includes('brand_new_tag'), 'a genuinely new tag is observed at runtime');

  const prevClosed = process.env.GM_PRD_CLOSED_STATUSES;
  process.env.GM_PRD_CLOSED_STATUSES = 'shipped';
  assert(reg.prdClosedStatuses().includes('shipped'), 'closed-status vocabulary is configurable');
  if (prevClosed === undefined) delete process.env.GM_PRD_CLOSED_STATUSES; else process.env.GM_PRD_CLOSED_STATUSES = prevClosed;

  fs.rmSync(parseRoot, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

{
  // gm's runtime failures carry neither ok:false nor err, so the snapshot's `errors` counter
  // reads 0 while real panics and unprocessable spool requests sit in the same event set.
  const failRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsniff-runtime-fail-'));
  const failProj = path.join(failRoot, 'panicky');
  const failSpool = path.join(failProj, '.gm', 'exec-spool');
  fs.mkdirSync(failSpool, { recursive: true });
  fs.writeFileSync(path.join(failSpool, '.watcher.log'), [
    '--- watcher spawn 2026-07-27T10:00:00.000Z supervisor=111 reason=boot ---',
    '[plugkit-wasm] evt: {"event":"wasm_panic","location":"src/orchestrator/mod.rs:73:5","message":"gm_dir: project root resolution failed","ts":"2026-07-27T10:00:01.000Z"}',
    '[plugkit-wasm:err] error processing prd-resolve.txt: ENOENT: no such file or directory',
    "[retention] failed to sweep browser: EPERM: operation not permitted, unlink 'out/browser'",
    'turn-state.json parse failed (missing field `phase`)',
    '[plugkit-wasm] evt: {"event":"dispatch.end","verb":"recall","task":"t1","ms":5,"ts":"2026-07-27T10:00:02.000Z"}',
    '',
  ].join('\n'));

  const prevFailSpool = process.env.GM_SPOOL_DIRS;
  process.env.GM_SPOOL_DIRS = failProj;
  const failSrv = await createServer({ logDir: DEFAULT_LOG_DIR, port: 0 });
  const failSnap = await (await fetch(failSrv.url + '/api/snapshot')).json();

  // GM_SPOOL_DIRS ADDS a root, it does not restrict discovery (C:/dev and cwd are always
  // scanned), so every count below is scoped to the fixture's own cwd rather than a
  // machine-dependent fleet-wide total.
  const failEventsHere = failSrv.store.events.filter(e => e.cwd === failProj);
  const countHere = (name) => failEventsHere.filter(e => e.event === name).length;

  assert.strictEqual(failSnap.errors, 0,
    'none of these failures carry ok:false/err -- which is exactly why `errors` alone hides them');
  // EXACT counts, deliberately. Store.load() replays every line on disk and the fanout's tailer
  // then starts at EOF rather than offset 0; without that, each of these is ingested twice and
  // every count gmsniff reports doubles -- a failure that just looks like larger, more credible
  // numbers. A >= here would not catch it.
  assert.strictEqual(countHere('wasm_panic'), 1, 'a real wasm panic is parsed exactly once');
  assert.strictEqual(countHere('spool.process-error'), 1, 'an unprocessable spool request is parsed exactly once');
  assert.strictEqual(countHere('retention.failed'), 1,
    'a failed retention sweep is parsed exactly once -- spool space never reclaimed');
  assert.strictEqual(countHere('turn-state.parse-failed'), 1, 'a rejected turn-state.json is parsed exactly once');
  for (const name of ['wasm_panic', 'spool.process-error', 'retention.failed', 'turn-state.parse-failed']) {
    assert(failSnap.runtimeFailures[name] >= 1, `${name} reaches the snapshot's runtime-failure breakdown`);
  }
  assert.strictEqual('dispatch.end' in failSnap.runtimeFailures, false,
    'a healthy dispatch is never counted as a failure');
  assert.strictEqual(
    failSnap.runtimeFailuresTotal,
    Object.values(failSnap.runtimeFailures).reduce((n, x) => n + x, 0),
    'the total is exactly the sum of the named counts, with no unnamed residue');

  const panicHere = failEventsHere.find(e => e.event === 'wasm_panic');
  assert.strictEqual(panicHere.location, 'src/orchestrator/mod.rs:73:5',
    'the panic keeps gm\'s own structured location field');

  const ph = await (await fetch(failSrv.url + '/api/parse-health')).json();
  assert.strictEqual(ph.project_count, ph.projects.length, 'project_count matches the rows actually returned');
  const panicky = ph.projects.find(p => p.name === 'panicky');
  assert(panicky, 'the fixture project appears in parse-health');
  assert.strictEqual(panicky.unmodeled_ratio, 0, 'every fixture line matches a modeled shape');
  assert.strictEqual(typeof panicky.signal_ratio, 'number', 'signal_ratio splits modeled coverage from ignored noise');
  assert.strictEqual(typeof ph.correlation.dominant_kind, 'string',
    'correlation reports what the grouping is really worth, not just its best-available identity');

  // A retired verb is a real match arm whose handler always errors, so the spool write is refused
  // rather than queued to fail -- the CLI already refused it; the route did not.
  const retired = await fetch(failSrv.url + '/api/lifecycle', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: failProj, verb: 'learn', payload: {} }),
  });
  assert.strictEqual(retired.status, 400, 'a retired verb is rejected by /api/lifecycle');
  assert.strictEqual((await retired.json()).retired, true, 'the rejection names retirement as the reason');
  assert.strictEqual(fs.existsSync(path.join(failSpool, 'in', 'learn')), false,
    'a rejected retired verb writes nothing to the spool');

  // ---- write routes ----------------------------------------------------------------------
  // Every route below MUTATES real files or the real spool, so each asserts against what
  // actually landed on disk, never against the response body alone: a handler that returns
  // {ok:true} while writing nothing is precisely the returns-success-while-broken class.
  const postJson = (route, body) => fetch(failSrv.url + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  // REGRESSION: the project-discovery cache was keyed on the wall clock alone, so a project
  // whose events were already in store.events was still absent from the registry for the whole
  // 5s TTL and every cwd-scoped route rejected it 403 "cwd not in discovered project registry".
  // This block runs immediately after /api/snapshot warmed that cache, which is exactly the
  // window the bug lived in -- so a 200 here IS the regression assertion.
  assert(failSrv.store.events.some(e => e.cwd === failProj),
    'the fixture project has events in the store before any cwd-scoped route is called');

  // A known-good verb writes exactly one payload file into in/<verb>/.
  const accepted = await postJson('/api/lifecycle', { cwd: failProj, verb: 'status', payload: { k: 1 } });
  assert.strictEqual(accepted.status, 200, 'a known, non-retired verb is accepted by /api/lifecycle');
  const acceptedBody = await accepted.json();
  assert.strictEqual(acceptedBody.ok, true, '/api/lifecycle reports the write succeeded');
  const statusDir = path.join(failSpool, 'in', 'status');
  const statusFiles = fs.readdirSync(statusDir);
  assert.strictEqual(statusFiles.length, 1, 'exactly one spool file is written, not zero and not two');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(statusDir, statusFiles[0]), 'utf-8')), { k: 1 },
    'the spool file carries the caller\'s payload verbatim');
  assert.strictEqual(acceptedBody.file, path.join(statusDir, statusFiles[0]),
    'the returned path is the file that actually exists, so a caller can poll for its response');

  // An unknown verb is refused before any directory is created.
  const unknownVerb = await postJson('/api/lifecycle', { cwd: failProj, verb: 'notaverb', payload: {} });
  assert.strictEqual(unknownVerb.status, 400, 'an unknown verb is rejected by /api/lifecycle');
  assert.strictEqual(fs.existsSync(path.join(failSpool, 'in', 'notaverb')), false,
    'a rejected unknown verb writes nothing to the spool');

  // The cwd allowlist is the only thing standing between these write routes and an arbitrary
  // filesystem path, so its rejection path is asserted on every writing route, not just one.
  const outsideCwd = path.join(failRoot, 'not-a-discovered-project');
  for (const [route, body] of [
    ['/api/lifecycle', { cwd: outsideCwd, verb: 'status', payload: {} }],
    ['/api/prd/edit', { cwd: outsideCwd, id: 'x', status: 'done' }],
    ['/api/mutables/edit', { cwd: outsideCwd, id: 'x', status: 'witnessed' }],
    ['/api/codesearch', { cwd: outsideCwd, query: 'q' }],
  ]) {
    const rejected = await postJson(route, body);
    assert.strictEqual(rejected.status, 403, `${route} refuses a cwd outside the discovered project registry`);
    assert.strictEqual((await rejected.json()).error, 'cwd not in discovered project registry',
      `${route} names the registry as the reason it refused`);
  }
  assert.strictEqual(fs.existsSync(outsideCwd), false,
    'no write route created anything under the rejected cwd');

  // `..` is refused ahead of the registry check, so a traversal attempt never reaches a stat.
  const traversal = await postJson('/api/lifecycle', { cwd: `${failProj}/../..`, verb: 'status', payload: {} });
  assert.strictEqual(traversal.status, 403, 'a cwd containing .. is refused');
  assert.strictEqual((await traversal.json()).error, 'invalid cwd',
    'a traversal cwd is refused as malformed, distinct from being out of registry');

  // ---- prd/mutables edit: the on-disk file is the assertion, not the response ----
  const failGm = path.join(failProj, '.gm');
  fs.writeFileSync(path.join(failGm, 'prd.yml'), [
    '- id: modern-row', '  status: pending', '  text: original text',
    // A legacy non-`id` boundary row: ../gm's live mutables.yml carries 41 of these behind
    // mutable_id/text/subject/name/prd_id/repo/title, so rewriting one must preserve the
    // boundary key rather than reshaping the row into `- id:`.
    '- subject: legacy boundary row', '  id: legacy-row', '  status: pending', '',
  ].join('\n'));
  fs.writeFileSync(path.join(failGm, 'mutables.yml'), [
    '- id: mut-row', '  status: unknown', '  witness_evidence: none yet', '',
  ].join('\n'));

  const prdEdited = await postJson('/api/prd/edit', { cwd: failProj, id: 'modern-row', status: 'done', text: 'rewritten' });
  assert.strictEqual(prdEdited.status, 200, '/api/prd/edit accepts an edit to a real row');
  const prdOnDisk = fs.readFileSync(path.join(failGm, 'prd.yml'), 'utf-8');
  assert(/^- id: modern-row\n  status: done\n/m.test(prdOnDisk),
    'the PRD row on disk really carries the new status, not just the response body');
  assert(prdOnDisk.includes('rewritten'), 'the new text landed in the file');
  assert.strictEqual(prdOnDisk.includes('original text'), false, 'the old text is gone, not duplicated');

  // Byte preservation for every row the caller did NOT name.
  assert(prdOnDisk.includes('- subject: legacy boundary row'),
    'an untouched legacy-boundary row keeps its own boundary key byte-for-byte');

  const legacyEdited = await postJson('/api/prd/edit', { cwd: failProj, id: 'legacy-row', status: 'done' });
  assert.strictEqual(legacyEdited.status, 200, '/api/prd/edit reaches a row whose boundary key is not `id`');
  const prdAfterLegacy = fs.readFileSync(path.join(failGm, 'prd.yml'), 'utf-8');
  assert(/^- subject:/m.test(prdAfterLegacy),
    'rewriting a legacy row re-emits its original boundary key, never reshaping it into `- id:`');
  assert.strictEqual(/^- id: legacy-row$/m.test(prdAfterLegacy), false,
    'the legacy row did not gain an `- id:` boundary it never had');
  // Asserted on the parsed row rather than the raw bytes: yamlScalar quotes a value containing
  // spaces, so `- subject: 'legacy boundary row'` is the correct emission and a byte-literal
  // check would fail on formatting while the row is in fact intact.
  const legacyRoundTripped = parseYamlRows(prdAfterLegacy).find(r => r.id === 'legacy-row');
  assert.strictEqual(legacyRoundTripped._boundary, 'subject',
    'the rewritten legacy row still parses with its original boundary key');
  assert.strictEqual(legacyRoundTripped.subject, 'legacy boundary row',
    'the boundary value survives the quote round-trip byte-for-byte in meaning');
  assert.strictEqual(legacyRoundTripped.status, 'done', 'the legacy row really took the new status');

  const mutEdited = await postJson('/api/mutables/edit', { cwd: failProj, id: 'mut-row', status: 'witnessed', witness: 'file:1' });
  assert.strictEqual(mutEdited.status, 200, '/api/mutables/edit accepts an edit to a real row');
  const mutOnDisk = fs.readFileSync(path.join(failGm, 'mutables.yml'), 'utf-8');
  assert(/^  status: witnessed$/m.test(mutOnDisk), 'the mutable row on disk carries the new status');
  assert(mutOnDisk.includes('file:1'), 'the witness the caller supplied landed in the file');

  // A missing row is a 404 and must leave the file untouched -- a rewriteRow returning null that
  // was written anyway would truncate the store.
  const bytesBefore = fs.readFileSync(path.join(failGm, 'prd.yml'), 'utf-8');
  const missingRow = await postJson('/api/prd/edit', { cwd: failProj, id: 'no-such-row', status: 'done' });
  assert.strictEqual(missingRow.status, 404, 'editing a row that does not exist is a 404');
  assert.strictEqual(fs.readFileSync(path.join(failGm, 'prd.yml'), 'utf-8'), bytesBefore,
    'a 404 edit leaves the file byte-identical');

  // Optimistic concurrency: a stale `since` mtime must refuse rather than clobber a concurrent write.
  const stale = await postJson('/api/prd/edit', { cwd: failProj, id: 'modern-row', status: 'pending', since: 1 });
  assert.strictEqual(stale.status, 409, 'an edit carrying a stale mtime is refused as a conflict');
  const staleBody = await stale.json();
  assert.strictEqual(typeof staleBody.mtimeMs, 'number', 'the conflict reports the mtime the caller must re-read from');
  assert.strictEqual(staleBody.currentRow.status, 'done',
    'the conflict hands back the row as it actually is now, so the caller can merge');
  assert(fs.readFileSync(path.join(failGm, 'prd.yml'), 'utf-8').includes('status: done'),
    'a refused conflicting edit changed nothing on disk');

  // ---- lifecycle/response filename validation ----
  // The `file` parameter names a file inside .gm/exec-spool/out and is attacker-controlled, so
  // every shape that could escape that directory is refused BEFORE any read is attempted.
  const failOut = path.join(failSpool, 'out');
  fs.mkdirSync(failOut, { recursive: true });
  fs.writeFileSync(path.join(failOut, 'codesearch-1.json'), JSON.stringify({ hits: [{ path: 'a.js' }] }), 'utf-8');
  fs.writeFileSync(path.join(failProj, 'secret.json'), JSON.stringify({ secret: true }), 'utf-8');

  const respUrl = (file, verb = 'codesearch') =>
    `${failSrv.url}/api/lifecycle/response?cwd=${encodeURIComponent(failProj)}&verb=${encodeURIComponent(verb)}&file=${encodeURIComponent(file)}`;

  const goodResp = await (await fetch(respUrl('codesearch-1.json'))).json();
  assert.strictEqual(goodResp.ok, true, 'a well-formed response filename inside out/ is served');
  assert.deepStrictEqual(goodResp.response.hits, [{ path: 'a.js' }], 'the response body is the parsed file content');

  for (const bad of ['../secret.json', '..\\secret.json', 'sub/codesearch-1.json', 'sub\\codesearch-1.json', 'codesearch-1.txt', '.json']) {
    const r = await fetch(respUrl(bad));
    assert.strictEqual(r.status, 400, `/api/lifecycle/response refuses the file parameter ${JSON.stringify(bad)}`);
    assert(/invalid file parameter/.test((await r.json()).error),
      `the refusal of ${JSON.stringify(bad)} names the file parameter as the cause`);
  }
  // A traversal that is refused must not have leaked the file it aimed at.
  const escaped = await fetch(respUrl('../secret.json'));
  assert.strictEqual((await escaped.text()).includes('"secret"'), false,
    'a refused traversal returns no content from outside out/');

  const badVerb = await fetch(respUrl('codesearch-1.json', 'code search'));
  assert.strictEqual(badVerb.status, 400, 'the verb parameter is shape-checked too');
  assert.strictEqual((await badVerb.json()).error, 'invalid verb parameter',
    'a malformed verb is refused as a verb, not misreported as a bad filename');

  const absentResp = await fetch(respUrl('codesearch-absent.json'));
  assert.strictEqual(absentResp.status, 404,
    'a well-formed name with no file behind it is an honest 404, distinct from a 400 refusal');

  // ---- codesearch ----
  // No daemon is running against this fixture, so nothing will ever write the response file.
  // That is the real timeout path: the route must write its request and then 504 rather than
  // hang or claim success.
  const csEmpty = await postJson('/api/codesearch', { cwd: failProj, query: '' });
  assert.strictEqual(csEmpty.status, 400, 'an empty codesearch query is refused');
  const csLong = await postJson('/api/codesearch', { cwd: failProj, query: 'x'.repeat(4097) });
  assert.strictEqual(csLong.status, 400, 'a codesearch query over the length cap is refused');
  assert.strictEqual(fs.existsSync(path.join(failSpool, 'in', 'codesearch')), false,
    'a refused codesearch query writes no spool request');

  const csBadJson = await fetch(failSrv.url + '/api/codesearch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.strictEqual(csBadJson.status, 400, 'a malformed JSON body is refused rather than crashing the route');

  for (const route of ['/api/lifecycle', '/api/prd/edit', '/api/mutables/edit', '/api/codesearch']) {
    const wrongMethod = await fetch(failSrv.url + route);
    assert.strictEqual(wrongMethod.status, 405, `${route} is POST-only`);
  }

  if (prevFailSpool === undefined) delete process.env.GM_SPOOL_DIRS; else process.env.GM_SPOOL_DIRS = prevFailSpool;
  await failSrv.close();
  fs.rmSync(failRoot, { recursive: true, force: true });
}

// ---- client-side invariants -------------------------------------------------------------
// /api/project-signals is pinned above against ever attaching a severity, but until now
// NOTHING covered the client -- which is exactly how a ten-term attention score and a
// row-dropping filter reached gui/ while the server was locked down. gui/shared.js's exports
// are pure functions over a row and need no DOM, so they are asserted here directly, against
// the same module the browser loads.
{
  const sh = await import('./gui/shared.js');

  // The rule from AGENTS.md: order freely, surface the cause, never omit. attentionScore is
  // allowed to RANK because it ranks a complete list and states its reasons; it must never
  // become a filter. A row scoring zero with no reasons is still a row.
  const quietAgent = { row: { present: true, phase: 'EXECUTE', activity: 'unknown' } };
  const quiet = sh.attentionScore(quietAgent, Date.now());
  assert.strictEqual(typeof quiet.score, 'number', 'attentionScore returns a real number for a quiet agent');
  assert(Array.isArray(quiet.reasons), 'attentionScore always returns a reasons array');
  assert.strictEqual(quiet.reasons.length, 0, 'a quiet agent has no invented reasons attached');

  // Every contributing condition must ride along as a NAMED reason. A ranked list whose
  // reasons are hidden degrades back into a bare severity number and fails the rule again.
  const blockedAgent = {
    row: { present: true, phase: 'VERIFY', activity: 'idle' },
    gates: { blocked: true, blockers: [{ gate: 'prd-all-closed' }, { gate: 'worktree-clean' }] },
    devTrend: { trend: 'rising', recent: 4 },
    burndown: { trend: 'accumulating', delta: 7 },
  };
  const blocked = sh.attentionScore(blockedAgent, Date.now());
  assert(blocked.score > quiet.score, 'a blocked agent ranks above a quiet one');
  assert(blocked.reasons.length >= 3, 'every contributing condition states itself as a reason');
  assert(blocked.reasons.some(r => r.includes('prd-all-closed') && r.includes('worktree-clean')),
    'the blocking reason NAMES the gates behind it, never just a score');
  assert(blocked.reasons.some(r => r.includes('4')), 'the deviation reason carries its measured count');
  assert(blocked.reasons.some(r => r.includes('7')), 'the PRD reason carries its measured delta');
  for (const r of blocked.reasons) {
    for (const verdict of ['critical', 'severe', 'degraded', 'unhealthy', 'bad']) {
      assert.strictEqual(r.toLowerCase().includes(verdict), false,
        `attention reason "${r}" must state a measurement, never the verdict word "${verdict}"`);
    }
  }

  // A nullable measurement must not invert its own meaning. staleSeconds == null is "no events
  // EVER recorded" -- the most silent project there is -- and default numeric coercion sorted
  // it as zero seconds silent, putting the most suspicious row last.
  const neverSeen = { cwd: 'C:/dev/never', staleSeconds: null, deviationRate: 0 };
  const quietFor2h = { cwd: 'C:/dev/quiet', staleSeconds: 7200, deviationRate: 0 };
  const justSpoke = { cwd: 'C:/dev/fresh', staleSeconds: 5, deviationRate: 0 };
  const sorted = [justSpoke, quietFor2h, neverSeen].sort(sh.longestSilentFirst);
  assert.strictEqual(sorted[0].cwd, 'C:/dev/never',
    'a project with NO events ever sorts as most-silent, not as zero seconds silent');
  assert.strictEqual(sorted[2].cwd, 'C:/dev/fresh', 'the freshest project sorts last');
  // The tie-break is a real second measurement, not an invented weight.
  const tieA = { cwd: 'C:/dev/a', staleSeconds: 100, deviationRate: 9 };
  const tieB = { cwd: 'C:/dev/b', staleSeconds: 100, deviationRate: 1 };
  assert.strictEqual([tieB, tieA].sort(sh.longestSilentFirst)[0].cwd, 'C:/dev/a',
    'equal silence falls through to the measured deviation rate');

  // liveness reports what the server classified; it must never upgrade a row on the
  // shared-daemon `alive` flag, which read identically for all 63 projects.
  assert.strictEqual(sh.liveness({ present: true, phase: 'EXECUTE', activity: 'abandoned', alive: true }), 'dead',
    'a shared-daemon alive:true never overrides a per-project abandoned classification');
  assert.strictEqual(sh.liveness({ present: true, phase: 'EXECUTE', activity: 'dispatching' }), 'active',
    'the server-published activity is authoritative');
  assert.strictEqual(sh.liveness({ present: false }), 'none', 'a directory with no gm state is not an agent');
  assert.strictEqual(sh.liveness({ present: true, phase: 'PLAN' }), 'unknown',
    'an unclassifiable row is honestly unknown, never assumed active');

  // agentAges keeps two ages that answer two different questions apart. Collapsing them hides
  // the wedged case: long in-phase but fresh last-event is working; both long is stuck.
  const ages = sh.agentAges({ in_phase_ms: 600000, last_event_ms: 1000, instruction_served_ms: 900000 }, null, Date.now());
  assert.strictEqual(ages.sinceEnteringPhase, 600000, 'in-phase age is reported as its own measurement');
  assert.strictEqual(ages.sinceLastEvent, 1000, 'last-event age is never merged into the in-phase age');
  assert.notStrictEqual(ages.sinceEnteringPhase, ages.sinceLastEvent, 'the two ages stay distinct');
  const noAges = sh.agentAges({}, null, Date.now());
  assert.strictEqual(noAges.sinceLastEvent, null,
    'an unmeasurable age is null, never 0 -- "no events observed" is not "0ms ago"');

  // ageMs clamps a future timestamp rather than rendering a negative age.
  const now = Date.now();
  assert.strictEqual(sh.ageMs(now + 60000, now), 0, 'a future ts from another machine clamps to zero, never negative');
  assert.strictEqual(sh.ageMs(null, now), null, 'an absent ts is null, not zero');
  assert.strictEqual(sh.ageMs('not-a-date', now), null, 'an unparseable ts is null, not NaN');

  // phaseDivergence reports BOTH sides of one comparison, so the flag and the phases it names
  // can never come from separately-derived fields.
  const diverged = sh.phaseDivergence({ phase_served: 'PLAN', phase_authoritative: 'EXECUTE' });
  assert.deepStrictEqual(diverged, { served: 'PLAN', actual: 'EXECUTE' }, 'divergence names both phases');
  assert.strictEqual(sh.phaseDivergence({ phase_served: 'PLAN', phase_authoritative: 'PLAN' }), null,
    'agreement is not a divergence');
  assert.strictEqual(sh.authoritativePhase({ phase_served: 'PLAN', phase_authoritative: 'EXECUTE' }), 'EXECUTE',
    'turn-state.json wins over next-step.md prose on the client too');

  // A project whose FSM graph redefines the phases must not be forced back onto the six-phase
  // literal; a phase the fallback does not know still appears in the walk.
  assert.deepStrictEqual(sh.phaseUniverse({ phases: ['A', 'B'] }), ['A', 'B'], 'a row carrying its own phases wins');
  assert(sh.phaseUniverse({ phase: 'TRIAGE' }).includes('TRIAGE'),
    'a real phase outside the fallback is added rather than dropped from the walk');

  // verbDurations reports the real distribution. A median standing alone cannot distinguish
  // 1.2x from 40x, which is why p95 and max ride with it.
  const durs = sh.verbDurations([
    { kind: 'dispatch', verb: 'recall', ms: 10 }, { kind: 'dispatch', verb: 'recall', ms: 20 },
    { kind: 'dispatch', verb: 'recall', ms: 300 }, { kind: 'dispatch', verb: 'codesearch', ms: 5 },
    { kind: 'instruction', verb: 'ignored', ms: 999 },
  ]);
  const recallStats = durs.find(d => d.verb === 'recall');
  assert.strictEqual(recallStats.count, 3, 'only dispatch rows with a real ms are counted');
  assert.strictEqual(recallStats.max, 300, 'the max is reported alongside the median');
  assert.strictEqual(durs.some(d => d.verb === 'ignored'), false, 'a non-dispatch row is not timed as a verb');

  // prdBurndown must say "unknown" rather than guess a trend from a single point.
  assert.strictEqual(sh.prdBurndown([{ kind: 'instruction', prd_pending: 5, ts: 1 }]).trend, 'unknown',
    'one data point is not a trend');
  assert.strictEqual(sh.prdBurndown([
    { kind: 'instruction', prd_pending: 9, ts: 1 }, { kind: 'instruction', prd_pending: 2, ts: 2 },
  ]).trend, 'converging', 'a falling pending count is converging');
  assert.strictEqual(sh.prdBurndown([]).trend, 'unknown', 'no points is unknown, never "flat"');

  // deviationTrend compares halves of the observed window; with under two points it must not
  // manufacture a direction.
  assert.strictEqual(sh.deviationTrend([]).count, 0, 'no deviations counts zero');
  assert.strictEqual(sh.deviationTrend([{ kind: 'deviation', ts: new Date().toISOString() }]).trend, 'flat',
    'a single deviation is not a rising trend');

  // resolveInflight pairs strictly on `task` and ages a start out, because dispatch.start's ts
  // is the EMPTY STRING in real data (45 starts against 2721 ends) -- a naive unmatched-start
  // scan reports dozens of agents as running forever.
  const stillOpen = sh.resolveInflight([
    { kind: 'dispatch', verb: 'recall', task: '1', inflight: true, ts: new Date().toISOString() },
    { kind: 'dispatch', verb: 'recall', task: '1' },
    { kind: 'dispatch', verb: 'browser', task: '2', inflight: true, ts: new Date().toISOString() },
  ], Date.now());
  assert.strictEqual(stillOpen.length, 1, 'a start matched by its end is not reported in-flight');
  assert.strictEqual(stillOpen[0].verb, 'browser', 'the genuinely open dispatch is the one reported');
  const blankTs = sh.resolveInflight([{ kind: 'dispatch', verb: 'x', task: '9', inflight: true, ts: '' }], Date.now());
  assert.strictEqual(blankTs[0].ageMs, null, 'a start with a blank ts reports unknown duration, not a fabricated age');
  assert.strictEqual(blankTs[0].abandoned, false, 'an unageable start is never declared abandoned');

  // gui/live-agents.js is deliberately NOT imported here: it imports `webjsx` and the `ds/`
  // importmap alias, so a try/catch around the import would silently skip every assertion
  // inside it and report green -- an assertion that never runs is worse than none. Only
  // gui/shared.js is asserted, because only it is genuinely loadable outside a browser.
}

// gui/ against the design SDK's own rules. The SDK's fourteen linters each
// hardcode their own repo root and sheet list, so scripts/lint-gui-ds.mjs
// re-derives the consumer-applicable rules and runs them here. Asserted as an
// exact zero per rule, not a threshold: this pass cleared 17 physical left/
// right properties, 16 raw colour literals, 3 var() refs to tokens declared
// nowhere, and 2 !important, and a threshold would let any of them back.
{
  const { findGuiViolations } = await import('./scripts/lint-gui-ds.mjs');
  const violations = findGuiViolations();
  for (const [rule, list] of Object.entries(violations)) {
    assert.strictEqual(list.length, 0,
      `gui/ must stay clean under the SDK ${rule} rule, found ${list.length}: ${list.slice(0, 3).join(' | ')}`);
  }

  // Zero external-origin runtime fetches is a load-bearing property (AGENTS.md):
  // gmsniff must install and run air-gapped and must never become a supply-chain
  // surface for the agent host it observes. Witnessed live at 242 requests, all
  // to 127.0.0.1; asserted here so a CDN script, remote font or remote
  // stylesheet cannot land silently in a later edit.
  {
    const guiFiles = [];
    const walkGui = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkGui(p);
        else if (/\.(html|js|mjs|css)$/.test(e.name)) guiFiles.push(p);
      }
    };
    walkGui(path.join(process.cwd(), 'gui'));
    // A protocol-relative or absolute URL in a src/href/@import/url()/fetch is
    // an external origin; a bare "http" inside a comment or a string of prose is
    // not, so the match is anchored to the positions that actually load.
    const EXTERNAL_LOAD = /(?:src|href)\s*=\s*["'](?:https?:)?\/\/|@import\s+(?:url\()?["'](?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|fetch\(\s*["'](?:https?:)?\/\//gi;
    const offenders = [];
    for (const f of guiFiles) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(EXTERNAL_LOAD)) {
        offenders.push(path.relative(process.cwd(), f).split(path.sep).join('/') + ': ' + m[0]);
      }
    }
    assert.deepStrictEqual(offenders, [],
      `gui/ must make zero external-origin runtime fetches, found: ${offenders.join(' | ')}`);
    assert.ok(guiFiles.length > 20, `the external-fetch scan must actually see the gui tree, saw ${guiFiles.length} files`);
  }

  // The browser cannot import src/index.js, so gui/shared.js re-declares the
  // subsystem seed by hand. It had already drifted (SUBSYSTEMS carries rs_learn,
  // the seed did not), which silently shortened the first paint's list until
  // /api/capabilities landed. Nothing structural keeps these two in step.
  const { SUBSYSTEMS } = await import('./src/index.js');
  const { SEED_SUBS_UNTIL_CAPABILITIES_LAND } = await import('./gui/shared.js');
  for (const sub of SEED_SUBS_UNTIL_CAPABILITIES_LAND) {
    assert.ok(SUBSYSTEMS.includes(sub),
      `gui/shared.js seeds subsystem "${sub}" that src/index.js SUBSYSTEMS does not declare`);
  }
  assert.deepStrictEqual([...SEED_SUBS_UNTIL_CAPABILITIES_LAND].sort(), [...SUBSYSTEMS].sort(),
    'the gui subsystem seed and src/index.js SUBSYSTEMS must name the same set');

  // /api/capabilities is what the seed defers to, so it must be a superset of
  // it. The shared `get()` helper's server is already closed by this point, so
  // this needs its own short-lived one.
  const capsSrv = await createServer({ logDir, port: 0 });
  try {
    const caps = await (await fetch(capsSrv.url + '/api/capabilities')).json();
    for (const sub of SEED_SUBS_UNTIL_CAPABILITIES_LAND) {
      assert.ok(caps.subsystems.includes(sub),
        `/api/capabilities omits seeded subsystem "${sub}", so the first paint would list a subsystem the route denies`);
    }
  } finally {
    await capsSrv.close();
  }
}

console.log(`gmsniff OK — ${snap.total} events across ${days.length} days · live-feedback verified · multi-project fanout verified · formal-spec verified · stuck-state+throughput+memory-health+codeinsight-age verified · total-parser verified · watcher-log-total-parse+source-priority+correlation+project-state verified · gui-sdk-lint+subsystem-seed-parity verified`);
