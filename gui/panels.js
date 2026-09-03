// Barrel for the gui panel surface.
//
// This file held all 27 panels in 1164 lines. They are not one responsibility --
// they are a registry -- so they now live in four domain modules beside a
// shared-internals file, and this re-exports the whole surface so gui/app.js's
// router and every #panel= deep link import exactly what they did before.
//
// Each module names a domain, not a size bucket: events (stream, tables, day
// rollup), sessions (deviations, detail dialog, process tree), editors (PRD,
// mutables, lifecycle, codesearch, console, browser sessions), graphs (treemap,
// memory force graph). After the split none of the four imports from another --
// the only shared code is panels-internals.js.

export { SUB_COLORS } from './panels-internals.js';
export { Dashboard, ByDay, liveStreamDebugSnapshot, pushLiveEntry, LiveStream, renderEventTable, AllEvents, SubsystemPanel } from './panels-events.js';
export { Deviations, SessionDetailDialog, Sessions, ProcessTree } from './panels-sessions.js';
export { validatePrdField, validateMutableField, commitField, PrdEditor, MutablesEditor, lifecycleAct, LifecycleControl, Codesearch, runCodesearch, GmCallConsole, dispatchConsole, BrowserSessions } from './panels-editors.js';
export { CodeInsightPanel, stopMemoryGraphLayout, MemoryGraphPanel } from './panels-graphs.js';
