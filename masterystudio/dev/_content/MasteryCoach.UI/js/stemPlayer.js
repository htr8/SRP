// Web Audio stem mixer. Plays several stems in sample-accurate sync with per-stem mute/solo.
// Runs in the browser and every MAUI WebView, so the stems experience is identical everywhere.
//
// TWO engines (see docs/08_Audio_Engine/AudioStretchQuality.md):
//
//  1. PRIMARY — one multichannel Signalsmith Stretch node carrying ALL stems as channel pairs,
//     split after the node into per-stem gains for mute/solo. One engine instance means tempo,
//     pitch, seeking and gapless looping apply to every stem in the same DSP block — sync is
//     guaranteed by construction, and slowing down no longer detunes the music (the old
//     playbackRate mechanism resampled, so 70% tempo played ~a third flat).
//
//  2. FALLBACK — the previous mechanism: one AudioBufferSourceNode per stem (playbackRate tempo,
//     shared granular pitch node), used when the stretch node cannot be created.
//
// The exported API is identical for both engines; C# (JsStemPlayer) needs no changes.

import SignalsmithStretch from './vendor/SignalsmithStretch.js';
import { getSharedContext } from './audioContext.js';
import * as countInCore from './countIn.js';
import * as engineCommon from './engineCommon.js';
import * as decodeCache from './decodeCache.js';
import * as health from './stemsHealth.js';
import { encodeWavStereo } from './recorder.js';

const state = {
    ctx: null,
    dotnet: null,
    engine: 'none',   // 'stretch' | 'classic' | 'none'
    stems: [],        // { id, label, buffer, peaks, gainNode, source, muted } (buffer freed post-load under the stretch engine; peaks cached for the waveform)
    solo: [],         // ids of soloed stems (empty = none soloed; multi-select). Only these play + show in the waveform.
    range: null,      // { start, end, loop }
    tempoRatio: 1,
    pitchSemitones: 0,
    pan: 0,           // -1 (left) … 0 (center) … +1 (right); pinned to center while dual-mix plumbing exists (engineCommon.applyMasterPan)
    panner: null,     // shared master StereoPannerNode both engines route through
    dualMix: false,   // dual-mix output (DualMixPlan.md tier 1): monitor mix → L, room mix → R
    dualBuses: null,  // { monitor, room } bus pairs while dual-mix is on (engineCommon.ensureDualBuses)
    countInTap: null, // the count-in's hard-left sink while dual-mix is on (engineCommon.ensureCountInTap)
    countIn: { beats: 0, entryBeats: 0, secondsPerBeat: 0.5 }, // beats = clicks heard; entryBeats = where the mix enters (fractional)
    countInNodes: [], // scheduled click oscillators (cancelled on stop)
    skipMarks: [],
    lastSkipScan: 0,

    // Stretch engine (rebuilt per load — channel count depends on stem count).
    stretch: {
        node: null,
        splitter: null,
        mergers: [],
        duration: 0,
        position: 0,
        playing: false,
    },

    // Classic fallback.
    classic: {
        bus: null,
        pitchNode: null,
        playing: false,
        duration: 0,   // longest stem's length, set when the classic fallback is chosen at load
        position: 0,   // last seeked/derived song position (see classicPosition)
        startedAt: null,   // ctx time the current sources started — anchors the live playhead
        startedFrom: 0,    // song position the current sources started from
        skipTimer: null,
    },
};

export function setEndedCallback(dotnetRef) {
    state.dotnet = dotnetRef;
}

// Detach the .NET callback. MUST be called by the scoped C# player (JsStemPlayer.DisposeAsync)
// BEFORE it disposes its DotNetObjectReference: this module is a SINGLETON on the app-lifetime shared
// AudioContext (audioContext.js — never closed), so its state — including the still-running stretch
// node's setUpdateInterval position tick, the end watchdog, and the load-progress reporter — outlives
// every scoped JsStemPlayer instance. If state.dotnet still points at a disposed reference, each of
// those callbacks fires invokeMethodAsync on it at ~10 Hz and throws "no tracked object with id N"
// hundreds of times a second, which silently breaks position mirroring, end detection, and progress
// (the console-flood root cause behind "solo/pause/spinner look broken on web", 2026-07-12). Nulling
// it here makes every notify* a no-op until the next load re-registers a fresh reference.
export function clearEndedCallback() {
    state.dotnet = null;
}

function notifyEnded() {
    // CATCH the interop rejection (like OnStemLoadProgress below): this fires from the shared-context
    // end-watchdog, which ticks on the app-lifetime AudioContext straight through engine swaps (mixer
    // open/close, Original<->Stems). If the target JsStemPlayer object id is transiently unresolvable
    // ("no tracked object with id N" — same class as stale-dotnet-ref-flood) the promise rejects; left
    // unobserved it became a .NET unhandled error that TORE DOWN THE WHOLE CIRCUIT — the full page
    // reload/crash on repeated play/stop around a source switch (user report 2026-07-14). The end
    // notification is best-effort; swallow the fault.
    if (state.dotnet) {
        try { state.dotnet.invokeMethodAsync('OnStemsEnded').catch(() => {}); }
        catch (e) { /* dotnet ref already torn down (sync throw) — nothing to notify */ }
    }
}

function notifySkipped(position) {
    if (state.dotnet) {
        try { state.dotnet.invokeMethodAsync('OnStemsSkipped', position).catch(() => {}); }
        catch (e) { /* dotnet ref already torn down (sync throw) - nothing to notify */ }
    }
}

// The SHARED AudioContext (same one the metronome + recorder use), so a take recorded while stems
// play shares a clock with them — the prerequisite for sample-exact record-over-stems sync
// (RecordOverStemsSyncPlan.md). The stem player must NEVER close/suspend this context: the metronome
// and recorder depend on it staying alive. resume() is fine (gesture requirement).
function ensureCtx() {
    state.ctx = getSharedContext();
    health.watch(state.ctx);      // wobble monitor (#77): catch interruptions between watchdog ticks
    watchResumeReprime(state.ctx); // wobble FIX (#77): re-prime the stretch worklet on resume
    return state.ctx;
}

// WOBBLE FIX (#77): when iOS suspends the WebView audio (backgrounding, a route change, the
// lock-screen session seesaw) and then resumes, the Signalsmith stretch worklet's phase-vocoder
// pipeline is left half-full of STALE analysis state — refilling it on resume is heard as a pitch
// WARBLE. A plain BufferSource wouldn't warble (it just continues); the artifact is specific to the
// stretch node, which is why other web apps don't have it. The clean recovery is the SAME thing a
// seek does: reschedule the node at its current position (applyStretchSchedule flushes + re-primes
// the pipeline). So on a suspended->running edge WHILE the stretch node is playing, re-seek to where
// it was. Attached once per context. Guarded to fire only on the actual resume edge (not every state
// event) so it can't thrash. This does NOT prevent the suspend (a WebView can't) — it makes the
// resume clean instead of warbling.
const resumeWatched = new WeakSet();
function watchResumeReprime(ctx) {
    if (!ctx || !ctx.addEventListener || resumeWatched.has(ctx)) return;
    resumeWatched.add(ctx);
    let wasInterrupted = false;
    ctx.addEventListener('statechange', () => {
        try {
            const st = ctx.state;
            if (st === 'suspended' || st === 'interrupted') {
                wasInterrupted = true;
                return;
            }
            if (st === 'running' && wasInterrupted) {
                wasInterrupted = false;
                // Only re-prime a stretch node that's mid-playback; a paused/stopped engine, the classic
                // fallback, or a not-yet-started deferred count-in must be left alone.
                if (state.engine === 'stretch' && state.stretch.node && state.stretch.playing
                    && !countInPending()) {
                    const at = state.stretch.position || 0;
                    applyStretchSchedule({ input: at }); // flush + re-fill the vocoder cleanly at `at`
                    console.warn(`[stems-health] resume re-prime: re-seek stretch to ${at.toFixed(3)}s to flush the warble`);
                }
            }
        } catch (e) { /* never throw out of a state event */ }
    });
}

// Return an AudioBuffer whose sample rate matches the shared context. If `buffer` is already at the
// context rate (the common case — decodeAudioData resamples to it), it's returned as-is. When it isn't
// (a cache entry decoded on the backing player's DIFFERENT-rate context), render it through an
// OfflineAudioContext at OUR rate so the stretch worklet — which indexes PCM by the context rate —
// plays it at the correct pitch/speed instead of a rate-mismatch wobble.
async function resampleToContextRate(buffer) {
    const ctx = ensureCtx();
    if (buffer.sampleRate === ctx.sampleRate) {
        return buffer;
    }
    const frames = Math.max(1, Math.round(buffer.duration * ctx.sampleRate));
    const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtor(buffer.numberOfChannels, frames, ctx.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    return await offline.startRendering();
}

// Shared master panner every stem's output routes INTO before the destination, so L/R pan applies
// to the whole stem mix in both engines (engineCommon owns the mechanism).
function ensurePanner() {
    return engineCommon.ensureMasterPanner(ensureCtx(), state);
}

// ---------------------------------------------------------------------------------------------
// Dual-mix output (DualMixPlan.md tier 1) — monitor mix → hard LEFT, room mix → hard RIGHT
// ---------------------------------------------------------------------------------------------

// The dual-mix send matrix, pure for tests (effectiveGain's pattern): what fraction of one stem
// reaches each bus. Tier 1 is 0/1 sends — the monitor always hears the stem, the room hears it
// unless it's monitor-only. Volume/mute/solo sit UPSTREAM on the gain node and are deliberately
// not part of this decision. Exported for tests.
export function sendGains(monitorOnly) {
    return { monitor: 1, room: monitorOnly ? 0 : 1 };
}

// Route one stem's panNode to its output: straight to `offTarget` (today's single-bus wiring) or,
// when dual-mix is on, fanned through a pair of send gains into the monitor/room buses. `offTarget`
// doubles as the buses' fan-in, so the classic path keeps its pitch worklet downstream of the split
// (stretch passes the master panner, classic its bus — DualMixPlan.md §Both engines).
function connectStemOutput(stem, offTarget) {
    if (!stem.panNode) return;
    if (!state.dualMix) {
        stem.panNode.connect(offTarget);
        return;
    }
    const ctx = ensureCtx();
    const buses = engineCommon.ensureDualBuses(ctx, state, offTarget);
    const gains = sendGains(stem.monitorOnly);
    stem.monitorSend = ctx.createGain();
    stem.roomSend = ctx.createGain();
    stem.monitorSend.gain.value = gains.monitor;
    stem.roomSend.gain.value = gains.room;
    stem.panNode.connect(stem.monitorSend).connect(buses.monitor.gain);
    stem.panNode.connect(stem.roomSend).connect(buses.room.gain);
}

// Undo connectStemOutput for one stem: drop the panNode's outgoing connections (single-bus OR both
// sends) and release the send gains.
function disconnectStemOutput(stem) {
    if (stem.panNode) {
        try { stem.panNode.disconnect(); } catch { /* ignore */ }
    }
    for (const key of ['monitorSend', 'roomSend']) {
        if (stem[key]) {
            try { stem[key].disconnect(); } catch { /* ignore */ }
            stem[key] = null;
        }
    }
}

// Master dual-mix switch. ON: every stem re-routes through the send pairs and the count-in gets its
// hard-left tap (§3.1); the master pan pins to center structurally, because hard-panned plumbing now
// exists — a StereoPanner at pan ≠ 0 crossfeeds the buses into each other, leaking the click to the
// room (§3.2, engineCommon.applyMasterPan). OFF: today's single-bus graph, master pan restored. The
// off→on→off round-trip must land back on EXACTLY the original wiring — a dropped connection here is
// the silent-stem class of bug (stem-playback-silent-panner-bug) that no unit test catches; the
// "off = unchanged output" gate in the build order is the defense.
export function setDualMix(enabled) {
    enabled = !!enabled;
    if (state.dualMix === enabled) return;
    // The toggle rewires the very sinks any already-scheduled count-in clicks feed, and scheduled
    // oscillators can't be re-routed: abandon an in-flight count rather than strand half the clicks —
    // silent after an off-toggle, audible in the ROOM after an on-toggle. The music's own deferred
    // start stays scheduled, so the end-watchdog HOLD must stay too (unlike seek/setLoop, nothing
    // here issues a new schedule() to pop the stale pre-roll position — zeroing the hold would let
    // the watchdog read that stale position and false-fire "ended" under the pending start;
    // review finding 2026-07-12).
    cancelCountIn();
    state.dualMix = enabled;
    rewireStemOutputs();
    if (!enabled) engineCommon.teardownCountInTap(state);
}

// Per-stem Cue (DualMixPlan.md tier 1, Phase B): flip one stem between Both and monitor-only. The
// flag is the single source every wiring pass reads (connectStemOutput), so setting it also covers
// the next load/engine switch/dual-mix toggle; when the sends are currently wired the live gains
// update in place — a gain value write, no rewire, no glitch. Unknown ids no-op (a stale UI event
// after a library switch must not throw).
export function setStemCue(stemId, monitorOnly) {
    const stem = state.stems.find(s => s.id === stemId);
    if (!stem) return;
    stem.monitorOnly = !!monitorOnly;
    const gains = sendGains(stem.monitorOnly);
    if (stem.monitorSend) stem.monitorSend.gain.value = gains.monitor;
    if (stem.roomSend) stem.roomSend.gain.value = gains.room;
}

// Flat top-level alias for the Diagnostics HUD (the audioUnlockSnapshot pattern): ENGINE truth of
// the dual-mix routing — the objective half of "HUD matches ear" on device. `wired` = this stem's
// sends AND the buses they feed currently exist (a send whose bus was torn down is dangling, the
// exact state the flag must expose — review finding 2026-07-12). countInTap + masterPan cover the
// two special-cased mechanisms the buses don't: the hard-left click tap and the §3.2 pan pin
// (masterPan is the NODE value — 0 while pinned, whatever the user set once the plumbing is gone).
// Guarded: the module also loads under node for the pure-routing tests, where window doesn't exist.
if (typeof window !== 'undefined') {
    window.stemRoutingSnapshot = function () {
        return {
            dualMix: state.dualMix,
            countInTap: !!state.countInTap,
            masterPan: state.panner ? state.panner.pan.value : null,
            stems: state.stems.map(s => ({
                label: s.label, monitorOnly: !!s.monitorOnly, wired: !!(s.roomSend && state.dualBuses),
            })),
        };
    };
}

// Tear down and re-run every stem's output wiring for the current dualMix state. Buses are rebuilt
// from scratch each time: their fan-in target depends on the live engine, so a leftover pair from a
// previous engine/load would route around the classic pitch worklet. The no-graph check comes FIRST:
// tearing buses down and then bailing would strand any freshly-built wiring on dead nodes (the
// silent-stem class) if this ever ran inside a load's engine-'none' window — belt to the C#-side
// suspenders (SetDualMixAsync now serializes on the load gate; review finding 2026-07-12).
function rewireStemOutputs() {
    const offTarget = stemFanIn(state.engine);
    if (!offTarget) return; // nothing loaded — the next load's graph build wires from state.dualMix
    engineCommon.teardownDualBuses(state);
    for (const stem of state.stems) {
        disconnectStemOutput(stem);
        connectStemOutput(stem, offTarget);
    }
}

// The ONE statement of the engine → per-stem fan-in mapping. The graph-build paths and the dual-mix
// rewire must agree, or "loaded with dual-mix on" and "toggled on after load" build DIFFERENT graphs
// (e.g. dual buses routed around the classic pitch worklet — an audible divergence that only
// reproduces in one toggle order). Classic fans into its bus so the pitch worklet stays downstream;
// stretch fans into the master panner.
function stemFanIn(engine) {
    if (engine === 'classic') return state.classic.bus;
    if (engine === 'stretch') return ensurePanner();
    return null;
}

// Where the count-in clicks land: the dedicated hard-left tap while dual-mix is on — the clicks are
// NOT a stem (they'd otherwise connect to ctx.destination and sound on BOTH channels, leaking the
// count to the room, §3.1), and they deliberately bypass the monitor BUS, whose classic-path fan-in
// would drag them through the pitch worklet (see engineCommon.ensureCountInTap). Built on demand so
// it also covers the load-vs-play window when the buses are torn down. null = the countIn default
// (ctx.destination), today's behavior.
function countInSink() {
    return state.dualMix ? engineCommon.ensureCountInTap(ensureCtx(), state).gain : null;
}

// Count-in clicks on the mixer's own context — the handoff into the stems is sample-accurate in
// BOTH engines. The core lives in countIn.js, shared with the track player; these thin wrappers
// bind it to this module's state.
function countInIntervalSeconds() {
    return countInCore.countInIntervalSeconds(state.countIn, state.tempoRatio);
}

function scheduleClicks(ctx, startAt) {
    countInCore.scheduleCountInClicks(
        ctx, startAt, state.countIn.beats, countInIntervalSeconds(), state.countInNodes, 'stems',
        countInSink());
}

function cancelCountIn() {
    countInCore.cancelCountInNodes(state.countInNodes, 'stems');
}

// True while a count-in's deferred start is still ahead of us. seek/setLoop/setTempoAndPitch must
// abandon the count then: any schedule() call pops the pending future segment in the vendor node —
// the music would start immediately, mid-count, at a derived position — so the clicks must not
// keep firing over it.
function countInPending() {
    return state.ctx != null && state.ctx.currentTime < (state.stretch.holdEndCheckUntil || 0);
}

function cancelPendingCountIn() {
    if (!countInPending()) return;
    cancelCountIn();
    state.stretch.holdEndCheckUntil = 0; // re-arm the watchdog: the deferred start no longer exists
}

// ---------------------------------------------------------------------------------------------
// Stretch engine
// ---------------------------------------------------------------------------------------------

function teardownStretchGraph() {
    const s = state.stretch;
    if (s.node) {
        try { s.node.stop(); s.node.disconnect(); } catch { /* ignore */ }
    }
    if (s.splitter) {
        try { s.splitter.disconnect(); } catch { /* ignore */ }
    }
    for (const merger of s.mergers) {
        try { merger.disconnect(); } catch { /* ignore */ }
    }
    s.node = null;
    s.splitter = null;
    s.mergers = [];
    s.playing = false;
    s.position = 0;
}

// One stretch node with 2 channels per stem; after the node a splitter feeds per-stem
// stereo mergers and gain nodes, so mute/solo stay per-stem while DSP is shared.
async function buildStretchGraph(stemCount) {
    const ctx = ensureCtx();
    const channels = stemCount * 2;
    const node = await SignalsmithStretch(ctx, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
    });

    const splitter = ctx.createChannelSplitter(channels);
    node.connect(splitter);

    const mergers = [];
    for (let i = 0; i < stemCount; i++) {
        const merger = ctx.createChannelMerger(2);
        splitter.connect(merger, 2 * i, 0);
        splitter.connect(merger, 2 * i + 1, 1);
        const gainNode = ctx.createGain();
        // Per-stem pan: merger → gain → StereoPanner → master panner, so each instrument can sit in
        // its own spot in the stereo field independently of the whole-mix pan. The merger → gain link
        // is essential — without it the stem's audio never reaches the gain/pan chain (silent stems).
        const panNode = ctx.createStereoPanner();
        panNode.pan.value = state.stems[i].pan ?? 0;
        merger.connect(gainNode).connect(panNode);
        state.stems[i].gainNode = gainNode;
        state.stems[i].panNode = panNode;
        // One funnel for the pan → output hop (single-bus or dual-mix sends), so a load that happens
        // while dual-mix is already on wires correctly from scratch. stemFanIn is passed explicitly:
        // state.engine isn't 'stretch' until the whole load commits.
        connectStemOutput(state.stems[i], stemFanIn('stretch'));
        mergers.push(merger);
    }

    // Position mirror + end-of-mix detection (shared watchdog, carrying the loop-wrap and
    // deferred-start guards — see engineCommon.makeEndWatchdog). Wrapped so the SAME 0.1 s tick also
    // feeds the wobble-health monitor (task #77): it samples ctx-clock vs worklet-position drift, rate
    // changes, and context interruptions into a rolling ring that auto-dumps to /diagnostics on anomaly.
    const watchdog = engineCommon.makeEndWatchdog(node, state, notifyEnded, (jumpTo) => {
        state.range = null;
        seek(jumpTo);
        notifySkipped(jumpTo);
    });
    node.setUpdateInterval(0.1, (inputTime) => {
        watchdog(inputTime);
        health.tick(state.ctx, inputTime, state.tempoRatio);
    });

    state.stretch.node = node;
    state.stretch.splitter = splitter;
    state.stretch.mergers = mergers;
}

// Single funnel for schedule() so tempo/pitch/loop state is always re-asserted together
// (engineCommon owns the loop/open-ended-end semantics).
function applyStretchSchedule(extra) {
    engineCommon.applyStretchSchedule(
        state.stretch.node, state.range, state.stretch.duration, state.tempoRatio, state.pitchSemitones, extra);
}

// ---------------------------------------------------------------------------------------------
// Classic fallback (previous mechanism)
// ---------------------------------------------------------------------------------------------

async function ensureClassicGraph() {
    if (state.classic.bus) return;
    const ctx = ensureCtx();
    state.classic.bus = ctx.createGain();
    if (ctx.audioWorklet) {
        try {
            await ctx.audioWorklet.addModule('./_content/MasteryCoach.UI/js/pitchShiftProcessor.js');
            state.classic.pitchNode = new AudioWorkletNode(ctx, 'pitch-shift-processor');
            state.classic.bus.connect(state.classic.pitchNode).connect(ensurePanner());
            applyClassicPitch();
            return;
        } catch { /* pitch no-ops; tempo still works */ }
    }
    state.classic.bus.connect(ensurePanner());
}

function applyClassicPitch() {
    if (state.classic.pitchNode) {
        state.classic.pitchNode.port.postMessage({ ratio: Math.pow(2, state.pitchSemitones / 12) });
    }
}

function stopClassicSources() {
    // Freeze the derived playhead before tearing the anchor down, so a pause-like caller (seek's
    // restart) resumes from where the sources actually were.
    state.classic.position = classicPosition();
    for (const stem of state.stems) {
        if (stem.source) {
            try { stem.source.onended = null; stem.source.stop(); } catch { /* already stopped */ }
            stem.source = null;
        }
    }
    state.classic.playing = false;
    state.classic.startedAt = null;
    stopClassicSkipTimer();
}

// The classic engine's live playhead: buffer sources report nothing, so the position is derived
// from the ctx clock and the start anchor, honoring the tempo ratio and wrapping inside an active
// loop window. While stopped it returns the parked/seeked position.
function classicPosition() {
    const c = state.classic;
    if (!c.playing || c.startedAt == null || !state.ctx) return c.position || 0;
    const elapsed = Math.max(0, state.ctx.currentTime - c.startedAt) * state.tempoRatio;
    let pos = c.startedFrom + elapsed;
    const r = state.range;
    if (r && r.loop) {
        const start = r.start;
        const end = r.end != null ? r.end : c.duration;
        const span = end - start;
        if (span > 0 && pos > end) pos = start + ((pos - start) % span);
    } else if (c.duration > 0 && pos > c.duration) {
        pos = c.duration;
    }
    return pos;
}

function stopClassicSkipTimer() {
    if (state.classic.skipTimer != null) {
        clearInterval(state.classic.skipTimer);
        state.classic.skipTimer = null;
    }
}

function startClassicSkipTimer() {
    stopClassicSkipTimer();
    state.classic.skipTimer = setInterval(() => {
        if (!state.classic.playing) {
            stopClassicSkipTimer();
            return;
        }

        engineCommon.scanSkipMarks(state, classicPosition(), (jumpTo) => {
            state.range = null;
            seek(jumpTo);
            notifySkipped(jumpTo);
        });
    }, 100);
}

// Create + start one buffer source per stem, all at the same ctx time `when`, playing from `from`.
// Shared by play() (classic branch) and seek's restart so end-detection and loop handling stay in one
// place — recreating sources without re-attaching the end watchdog would leave playback unable to
// signal that it finished (found in review of the seek path).
function startClassicSources(from, when) {
    const ctx = state.ctx;
    if (!ctx) return;

    const loop = !!(state.range && state.range.loop);
    const start = state.range ? state.range.start : 0;
    const end = state.range && state.range.end != null ? state.range.end : null;
    const begin = loop ? Math.max(start, from) : from;
    const duration = !loop && end != null ? Math.max(0, end - begin) : undefined;

    for (const stem of state.stems) {
        // Race guard: a play/seek landing while a load is still in flight can see a stem whose
        // buffer/gainNode isn't attached yet (or was just released by the stretch path). Skipping
        // it with a warn beats the old crash ("Cannot read properties of null") — the warn reaches
        // the diagnostics funnel, and the C# _loadGate only serializes load-vs-load, not load-vs-play.
        if (!stem.buffer || !stem.gainNode) {
            console.warn(`[stems] skipping '${stem.id}' at classic start: not fully loaded (load in flight?)`);
            stem.source = null;
            continue;
        }
        const src = ctx.createBufferSource();
        src.buffer = stem.buffer;
        src.playbackRate.value = state.tempoRatio; // same rate on all sources keeps them synced
        if (loop) {
            src.loop = true;
            src.loopStart = start;
            src.loopEnd = end != null ? end : stem.buffer.duration;
        }
        src.connect(stem.gainNode);
        stem.source = src;
    }

    for (const stem of state.stems) {
        if (!stem.source) continue; // skipped above
        if (duration != null && !loop) {
            stem.source.start(when, begin, duration);
        } else {
            stem.source.start(when, begin);
        }
    }
    state.classic.playing = true;
    // Anchor the live playhead: classic sources have no position reporting, so classicPosition()
    // derives it from how long they've been running (the stretch engine mirrors from the node).
    state.classic.startedAt = when;
    state.classic.startedFrom = begin;
    state.classic.position = begin;
    engineCommon.seedSkipScan(state, begin);
    startClassicSkipTimer();

    if (!loop) {
        // Signal ended from the LONGEST stem — stems[0] may be shorter than the others, which
        // would fire OnStemsEnded while the rest are still audible (review finding).
        let longest = state.stems[0];
        for (const stem of state.stems) {
            if (stem.buffer && stem.buffer.duration > (longest.buffer?.duration ?? 0)) longest = stem;
        }
        if (longest?.source) {
            longest.source.onended = () => {
                if (state.classic.playing) {
                    state.classic.playing = false;
                    notifyEnded();
                }
            };
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Exported API (engine-dispatching)
// ---------------------------------------------------------------------------------------------

// Load stems from .NET streams. `descriptors` is [{ id, label, streamRef }] where streamRef is the
// JS side of a DotNetStreamReference (an IBrowserFile stream). Returns loaded ids.
// Progress: one unit per stem decoded plus one for the final graph build/transfer, reported to .NET
// (OnStemLoadProgress) so the Studio can show a real determinate bar instead of a spinner — decoding
// dominates the load (seconds per stem), so per-stem ticks track the real work closely.
// True when the shared decode cache already holds this content-hash key — lets C# skip opening the
// (~49 MB) stream and hand a stream-less descriptor for JS to rebuild from the cache. See decodeCache.js.
export function hasDecodedStem(key) {
    return decodeCache.has(key);
}

export async function loadFromStreams(descriptors) {
    stopInternal();
    const ctx = ensureCtx();
    disposeStems();

    const totalUnits = descriptors.length + 1; // +1 = the graph build/transfer after the decodes
    let doneUnits = 0;
    const reportProgress = () => {
        // Fire-and-forget: progress must never fail or reorder the load itself.
        if (state.dotnet) { state.dotnet.invokeMethodAsync('OnStemLoadProgress', doneUnits, totalUnits).catch(() => {}); }
    };
    reportProgress(); // 0/N — the bar appears as soon as the load starts

    const loaded = [];
    for (const d of descriptors) {
        if (!d.streamRef && !decodeCache.has(d.key)) { doneUnits++; reportProgress(); continue; }
        try {
            // Reuse an already-decoded track when the backing player (or a prior mixer open) decoded it —
            // the Original-mix "song" channel is the SAME audio the AudioPlayer just decoded, and a decode
            // is the whole ~4 s cost. decodeCache holds context-independent channel arrays keyed by content
            // hash; rebuild a lightweight AudioBuffer on OUR context from them (an alloc+copy, not a decode).
            let buffer;
            const cached = decodeCache.get(d.key);
            if (cached) {
                // The Signalsmith worklet plays PCM indexed by OUR context's sample rate. The cache may
                // hold channels decoded on ANOTHER context (the backing player uses its own AudioContext,
                // which on iOS can run at a different hardware rate — e.g. 44100 vs 48000). Reusing that
                // PCM verbatim makes the worklet advance through it at the wrong rate — a detune that the
                // phase vocoder turns into an audible pitch WOBBLE (user report, 2026-07-11). Rebuild at
                // the cached rate, then resample to OUR rate when they differ so playback is correct.
                const raw = ctx.createBuffer(cached.channels.length, cached.length, cached.sampleRate);
                for (let c = 0; c < cached.channels.length; c++) {
                    raw.copyToChannel(cached.channels[c], c);
                }
                buffer = await resampleToContextRate(raw);
            } else {
                // readStreamRefBytes: arrayBuffer-first (native fast path) with the WASM chunked
                // fallback — stored-audio stem loads on web read MEMFS files through this hand-off.
                const bytes = await engineCommon.readStreamRefBytes(d.streamRef);
                // decodeAudioData throws on an unsupported codec or corrupt/partial file — skip that
                // one stem and keep the rest. It resamples to ctx.sampleRate, so a fresh decode already
                // matches; the guard below is defensive (and normalizes before caching).
                buffer = await resampleToContextRate(await ctx.decodeAudioData(bytes));
                // Populate the shared cache so a later switch/mixer-open reuses THIS decode too. Store the
                // raw channels (now at OUR context rate) under the descriptor's content-hash key.
                if (d.key) {
                    const channels = [];
                    for (let c = 0; c < buffer.numberOfChannels; c++) {
                        channels.push(buffer.getChannelData(c).slice()); // copy — the buffer's data may be transferred later
                    }
                    decodeCache.put(d.key, {
                        channels, duration: buffer.duration, sampleRate: buffer.sampleRate, length: buffer.length,
                    });
                }
            }
            // monitorOnly rides in on the descriptor: C# stamps it (PracticeStudio.LoadStemFiles,
            // next to the click force-mute) so click-stem identity has exactly ONE source
            // (PracticeManagementService.ClickStemLabel) — the engine just obeys the flag.
            state.stems.push({
                id: d.id, label: d.label, buffer, gainNode: null, panNode: null, source: null,
                muted: false, volume: 1, pan: 0, monitorOnly: !!d.monitorOnly,
            });
            loaded.push(d.id);
        } catch (err) {
            console.warn(`Could not decode stem "${d.label}":`, err);
        }
        doneUnits++;
        reportProgress();
    }

    if (state.stems.length === 0) return loaded;

    // Primary: single multichannel stretch node. Stems are padded to equal length (addBuffers
    // requires it) and interleaved as channel pairs.
    try {
        await buildStretchGraph(state.stems.length);
        // stem.buffer is non-null through this whole block (it's freed only at the end, line ~350):
        // loads are serialized on the C# side (JsStemPlayer._loadGate) so a concurrent load can't null
        // it out from under us. This line and the two below (computeStemPeaks / getChannelData) all
        // rely on that invariant — a half-guard on only one of them would be false confidence.
        const maxLength = Math.max(...state.stems.map(s => s.buffer.length));
        const maxDuration = maxLength / ctx.sampleRate;
        // Capture the decoded stem rate NOW (the buffers are freed just below) so [stems-diag] can flag a
        // buffer-vs-context rate mismatch — the #62 wobble suspect — at play time.
        state.stretch.bufferRate = state.stems[0].buffer.sampleRate;
        // ONE pass per stem: cache its peaks, copy its 2 padded channels, then FREE its decoded buffer
        // IMMEDIATELY. Previously we held all N decoded AudioBuffers AND a full second copy (the padded
        // channelData) at the same time — ~2× the total PCM. With 7 stems of a 4-6 min song that peak is
        // ~0.8-1.0 GB, which OOM-kills the WKWebView on iOS (a silent crash: the log ends mid-load with
        // no error, user report 2026-07-11). Freeing per stem roughly halves the peak. NOTE: this
        // commits to the stretch engine — the classic fallback below can no longer rebuild from the
        // decoded buffers, so it degrades to "no stems" if the stretch graph fails AFTER this point
        // (rare: the worklet's availability was already decided in buildStretchGraph above).
        const channelData = [];
        for (const stem of state.stems) {
            stem.peaks = computeStemPeaks(stem.buffer, peakBucketsFor(stem.buffer));
            stem.durationSeconds = stem.buffer.duration; // keep the duration; the buffer is freed below
            for (let c = 0; c < 2; c++) {
                const src = stem.buffer.getChannelData(Math.min(c, stem.buffer.numberOfChannels - 1));
                const padded = new Float32Array(maxLength);
                padded.set(src);
                channelData.push(padded);
            }
            stem.buffer = null; // release this stem's decoded PCM now — don't hold all N + all copies at once
        }
        // TRANSFER the channel buffers to the worklet (move, not clone) — cloning N stems × 2 channels
        // of full-song PCM in one postMessage blows the WASM heap (DataCloneError / out of memory).
        // Transferring hands ownership over with no copy.
        await state.stretch.node.addBuffers(channelData, channelData.map(a => a.buffer));
        state.stretch.duration = maxDuration;
        state.stretch.position = 0;
        state.engine = 'stretch';
        applyStretchSchedule({ input: 0, active: false });
        applyGains();
        doneUnits = totalUnits;
        reportProgress(); // graph built — 100%
        console.warn(`[stems-engine] stretch OK (${state.stems.length} stems, ${maxDuration.toFixed(1)}s)`);
        return loaded;
    } catch (err) {
        // #62: a stretch-graph build failure drops stems to the CLASSIC engine, whose per-source
        // playbackRate changes PITCH with tempo (a record-player detune — "pitch and speed go up/down
        // together"). This is the leading cause of that report on iOS. Log it LOUDLY with the reason and
        // stem count/channel total (addBuffers moves N×2 channels of full-song PCM into the WASM
        // worklet — a heap/DataCloneError here is the usual culprit), so /diagnostics shows WHY we fell
        // back rather than leaving a silent detune. console.error (not warn) so the errorCapture
        // re-entrancy guard is less likely to drop it.
        const chans = state.stems.length * 2;
        console.error(`[stems-engine] STRETCH BUILD FAILED → classic (detunes on tempo change). stems=${state.stems.length} channels=${chans} err=${err && err.name}: ${err && err.message}`);
        teardownStretchGraph();
        // Any dual buses the stretch attempt built fan into the MASTER PANNER; the classic path must
        // rebuild them fanning into its own bus so the pitch worklet stays in the chain.
        engineCommon.teardownDualBuses(state);
    }

    // Fallback: per-stem gain → per-stem pan → classic bus. NOTE: if we reached here AFTER the stretch
    // copy loop freed the decoded buffers (an addBuffers failure — rare), the classic engine has no PCM
    // to play; buildStretchGraph failing BEFORE the loop keeps buffers intact (the common fallback path).
    await ensureClassicGraph();
    for (const stem of state.stems) {
        disconnectStemOutput(stem); // drop any wiring a failed stretch attempt left on this stem
        stem.gainNode = ctx.createGain();
        stem.panNode = ctx.createStereoPanner();
        stem.panNode.pan.value = stem.pan ?? 0;
        stem.gainNode.connect(stem.panNode);
        connectStemOutput(stem, stemFanIn('classic')); // single-bus or dual-mix sends — same funnel as stretch
    }
    // The classic engine's duration/position come from here (no node to mirror from); without
    // this the engine reports duration 0, which silently disables waveform zoom windows and the
    // razor's duration-gated features (click-track generation). Fall back to the stem's saved
    // durationSeconds if its buffer was already freed by the stretch path above.
    state.classic.duration = Math.max(0, ...state.stems.map(s => s.buffer?.duration ?? s.durationSeconds ?? 0));
    state.classic.position = 0;
    state.engine = 'classic';
    applyGains();
    doneUnits = totalUnits;
    reportProgress();
    return loaded;
}

// Replace ONE stem's audio in place (e.g. a re-rendered click track) without reloading the rest —
// their decoded PCM was transferred into the stretch node at load and is not retained here, so a
// full reload re-decodes hundreds of MB for a one-stem change. This decodes just the new file,
// swaps the stem's channel pair inside the stretch node (a MasteryCoach patch on the vendored
// worklet), and refreshes the cached waveform peaks. Playback stops, mute/solo/volume/pan state
// stays (the graph and the stem entry are untouched). Returns false whenever the swap isn't
// possible so the caller can fall back to a full reload.
export async function replaceStemFromStream(descriptor) {
    const index = state.stems.findIndex(s => s.id === descriptor.id);
    if (index < 0 || !descriptor.streamRef) return false;

    const ctx = ensureCtx();
    let buffer;
    try {
        const bytes = await engineCommon.readStreamRefBytes(descriptor.streamRef); // WASM-safe read
        buffer = await ctx.decodeAudioData(bytes);
    } catch (err) {
        console.warn(`Could not decode replacement for stem "${descriptor.label}":`, err);
        return false;
    }

    stopInternal();
    const stem = state.stems[index];

    if (state.engine === 'stretch' && state.stretch.node) {
        // Pad/trim to the graph's fixed length — every channel in the segment must stay equal-length
        // (this is also how loadFromStreams shaped the original channels).
        const maxLength = Math.round(state.stretch.duration * ctx.sampleRate);
        const channelData = [];
        for (let c = 0; c < 2; c++) {
            const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
            const padded = new Float32Array(maxLength);
            padded.set(src.subarray(0, Math.min(src.length, maxLength)));
            channelData.push(padded);
        }

        stem.peaks = computeStemPeaks(buffer, peakBucketsFor(buffer));
        // TRANSFER the new pair in (move, not clone) and swap it into the worklet's segment.
        const ok = await state.stretch.node.replaceChannels(
            index * 2, channelData, channelData.map(a => a.buffer));
        if (!ok) {
            console.warn(`Stretch node refused the channel swap for "${descriptor.label}" — falling back to reload.`);
            return false;
        }

        return true;
    }

    if (state.engine === 'classic') {
        // Classic keeps decoded buffers and rebuilds sources on play — swapping the buffer suffices.
        stem.buffer = buffer;
        stem.peaks = computeStemPeaks(buffer, peakBucketsFor(buffer));
        state.classic.duration = Math.max(0, ...state.stems.map(s => s.buffer?.duration ?? 0));
        return true;
    }

    return false;
}

// The whole mute/solo/volume audibility decision, pure over its inputs so it is testable in Node
// (tests/js/effective-gain.test.mjs) — a regression here silently silences or un-mutes the wrong
// stems, the class of bug listening tests catch late. Exported for tests; callers pass state.solo.
export function effectiveGain(stem, solo) {
    if (stem.muted) return 0;
    // Multi-solo: if anything is soloed, only the soloed stems are audible.
    if (solo.length > 0 && !solo.includes(stem.id)) return 0;
    return stem.volume ?? 1; // per-stem volume (1 = unity); mute/solo still hard-gate to 0
}

// Per-stem volume, 0..N (1 = unity/original level). Applied live through the stem's gain node.
export function setStemVolume(id, volume) {
    const stem = state.stems.find(s => s.id === id);
    if (!stem) return;
    // Guard the public boundary: NaN/±Inf must never reach gain.value (Web Audio throws / goes silent).
    const v = Number(volume);
    stem.volume = Number.isFinite(v) ? Math.max(0, v) : 1;
    if (stem.gainNode) stem.gainNode.gain.value = effectiveGain(stem, state.solo);
}

// Per-stem pan, -1 (left) … 0 (center) … +1 (right). Applied live through the stem's panner node.
// Independent of the master pan (state.panner), which balances the whole mix.
export function setStemPan(id, pan) {
    const stem = state.stems.find(s => s.id === id);
    if (!stem) return;
    const p = Number(pan);
    stem.pan = Number.isFinite(p) ? Math.max(-1, Math.min(1, p)) : 0;
    if (stem.panNode) stem.panNode.pan.value = stem.pan;
}

function applyGains() {
    for (const stem of state.stems) {
        if (stem.gainNode) stem.gainNode.gain.value = effectiveGain(stem, state.solo);
    }
}

// Where the stretch engine should resume from: the loop/range start if set, else the parked position,
// with a guard so a position at/near the media end doesn't immediately re-trigger the end watchdog.
// Shared by play() and playAt() so the heuristic lives in ONE place.
function stretchInput() {
    const s = state.stretch, r = state.range;
    let input = r ? r.start : 0;
    if (r == null && s.position > 0 && s.position < s.duration - 0.05) input = s.position;
    if (s.duration > 0 && input >= s.duration - 0.1) input = r ? r.start : 0;
    return input;
}

// Start the stretch engine at the given shared-context time (both engines share applyStretchSchedule).
// `startInput` (optional) overrides the resume heuristic — the count-in phase alignment anchors the
// entry at the position its offset was measured at (see play()); playAt() and the plain path keep
// the parked-position resume.
function startStretchAt(output, startInput = null) {
    applyGains();
    const input = startInput != null ? startInput : stretchInput();
    logStretchStartDiag('startStretchAt', input, output);
    engineCommon.seedSkipScan(state, input);
    applyStretchSchedule({ input, active: true, output });
    // Until the deferred start actually begins, the node reports its STALE previous position —
    // seed the mirror (so the playhead/position polls show where playback will enter) and hold the
    // end watchdog off until just past the scheduled start (see the setUpdateInterval comment).
    state.stretch.position = input;
    state.stretch.holdEndCheckUntil = output + 0.2;
    state.stretch.playing = true;
    health.begin(state.ctx, state.tempoRatio, state.pitchSemitones); // wobble monitor (#77)
}

// The node's playback mode this start will drive (StemNeutralBypassPlan.md): at tempo 100% / pitch 0
// with no live input the worklet takes its NEUTRAL pass-through branch (stored PCM straight to output,
// no phase vocoder); anything else runs the stretch path. Predicted here from the SAME condition the
// worklet's isNeutralStoredPlayback checks, so /diagnostics can show which path a fresh start engaged
// without relying on ears. (Predicted, not confirmed: the diag is emitted synchronously at start,
// before the worklet has processed a block — but the branch is a pure function of tempo/pitch, so the
// prediction is exact for the stored-playback case these starts always are.)
function predictedNodeMode() {
    const neutral = Math.abs(state.tempoRatio - 1) < 1e-6 && Math.abs(state.pitchSemitones || 0) < 1e-6;
    return neutral ? 'neutral-bypass' : 'stretch';
}

// #62 diagnostics — log the pitch-relevant state at each stretch start so a residual transient can be
// diagnosed from a device log (console.warn is forwarded to /diagnostics). Reports the context rate,
// the node's reported latency, tempo/pitch ratios, and each stem buffer's own sample rate (a
// buffer-vs-context rate mismatch is the OTHER pitch cause — the continuous wobble already fixed by
// resampleToContextRate; this catches any that slip through).
function logStretchStartDiag(where, input, output) {
    // Build the line piece by piece so a throw in ANY single field (e.g. node.latency() before the WASM
    // node is ready) can't swallow the WHOLE line — the previous version's one big template + catch
    // emitted NOTHING when latency() threw, which is why [stems-diag] never appeared while [stems-engine]
    // did (device log 2026-07-11). Each field is guarded; on total failure we still log the reason.
    const num = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : String(v);
    try {
        const ctx = state.ctx;
        let latency = 'n/a';
        // latency() is async (a worklet-port promise) — this sync diag can only label it, not await it.
        try { const n = state.stretch.node; if (n && typeof n.latency === 'function') { const l = n.latency(); latency = (l && typeof l.then === 'function') ? 'async' : num(l, 4); } } catch (e) { latency = `err(${e && e.name})`; }
        const bufRate = state.stretch.bufferRate ?? '?';
        const ctxRate = ctx ? ctx.sampleRate : '?';
        const mismatch = bufRate !== '?' && ctxRate !== '?' && bufRate !== ctxRate;
        console.warn(
            `[stems-diag] ${where}: engine=${state.engine} mode=${predictedNodeMode()} ` +
            `ctxRate=${ctxRate} bufRate=${bufRate}` +
            `${mismatch ? ' RATE-MISMATCH!' : ''} tempo=${num(state.tempoRatio, 4)} ` +
            `pitchSemis=${state.pitchSemitones} nodeLatency=${latency} ` +
            `input=${num(input)} output=${num(output)} now=${ctx ? num(ctx.currentTime) : '?'}`);
    } catch (e) {
        console.warn(`[stems-diag] ${where}: FAILED to build diag line: ${e && (e.name + ': ' + e.message)}`);
    }
}

export async function play() {
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume(); // iOS gesture requirement
    if (state.stems.length === 0) return;

    cancelCountIn();
    // Clicks fire for the full count (`beats`); the mix ENTERS at entryBeats — a fractional beat
    // within the count (e.g. 2.5 = "and of 3"), so it can come in on an off-beat while the clicks
    // keep going (see setCountIn). With a grid-supplied first-beat offset the alignment pulls the
    // music-start delay earlier (or skips the file forward) so the song's own beat — not leading
    // silence or a mid-pickup file position — lands on the entry beat. The offset was MEASURED at
    // the section start (or 0), so a grid count-in anchors the entry there rather than at a parked
    // resume position, and the skip is bounded by what remains playable before the section/media
    // end (past that, alignment degrades to the plain entry instead of instantly "ending").
    const hasCountIn = state.countIn.beats > 0;
    const hasGridAlign = hasCountIn && state.countIn.firstBeatOffset != null;
    const gridEntry = state.range ? state.range.start : 0;
    let align = { delaySeconds: 0, skipSeconds: 0 };
    if (hasCountIn) {
        const endBound = state.range && state.range.end != null ? state.range.end : getDuration();
        align = countInCore.countInMusicAlignment(
            state.countIn, state.tempoRatio, endBound - gridEntry - 0.3);
    }

    if (state.engine === 'stretch') {
        if (hasCountIn) {
            const startAt = ctx.currentTime + 0.08;
            scheduleClicks(ctx, startAt);
            // LATENCY COMPENSATION (the "music comes in LATE after the count" bug): the CLICKS are plain
            // oscillators — they sound at their scheduled time. The SONG goes through the stretch worklet,
            // whose audible output emerges ~node.latency() AFTER its scheduled `output` time (its pipeline
            // must fill). So scheduling the music output AT the entry-beat click made the song sound
            // node.latency() LATE — a gap after the last click (user report 2026-07-13). Pull the music's
            // scheduled output EARLIER by the latency so the audible song lands ON the click. The no-count-in
            // path adds latency (no click to sync to, just fill the pipeline); the count-in path SUBTRACTS
            // it (there IS a reference — the click). Clamp so we never schedule before now (delaySeconds is
            // ≥ a beat in practice, so this only trims the lead, never goes negative). node.latency() is an
            // async worklet-port promise — must be awaited (feeding the promise into arithmetic → NaN →
            // silent worklet, the 2026-07-12 web-silence bug).
            const musicClickTime = startAt + align.delaySeconds;
            let latency = 0;
            const node = state.stretch.node;
            if (node && typeof node.latency === 'function') {
                try { const l = await node.latency(); if (typeof l === 'number' && isFinite(l)) latency = l; }
                catch { /* cold node — no compensation, same as before this fix */ }
            }
            const musicOutput = Math.max(ctx.currentTime + 0.02, musicClickTime - latency);
            startStretchAt(musicOutput, hasGridAlign ? gridEntry + align.skipSeconds : null);
        } else {
            applyGains();
            const input = stretchInput();
            // #62: the "play now" path also starts the node from cold analysis buffers, so the first
            // ~latency seconds of output would be a pitch smear. Schedule the audible output the node's
            // own latency into the future (instead of "now") so its internal pipeline is full by the
            // time output is heard — a clean start, at the cost of an imperceptible (~tens of ms) delay.
            // This does NOT replay earlier input, so nothing leaks before the intended start.
            // node.latency() is an ASYNC worklet-port call returning a PROMISE — it must be awaited.
            // Feeding the promise into Math.max made output NaN, which deactivated the worklet's
            // schedule entirely: perfect silence with a frozen playhead (web user report 2026-07-12,
            // reproduced + root-caused headless; the count-in path skips this block, which is why
            // every count-in-enabled device test kept passing).
            const node = state.stretch.node;
            let latency = 0;
            if (node && typeof node.latency === 'function') {
                try {
                    const l = await node.latency();
                    if (typeof l === 'number' && isFinite(l)) latency = l;
                } catch { /* cold node — keep 0, the 0.02 floor below still applies */ }
            }
            const output = ctx.currentTime + Math.max(0.02, latency);
            logStretchStartDiag('play(no-count-in)', input, output);
            engineCommon.seedSkipScan(state, input);
            applyStretchSchedule({ input, active: true, output });
            state.stretch.holdEndCheckUntil = output + 0.2;
            state.stretch.playing = true;
            health.begin(state.ctx, state.tempoRatio, state.pitchSemitones); // wobble monitor (#77)
        }
        return;
    }

    // Classic: one buffer source per stem, all started at the same ctx time. A parked/seeked
    // position resumes like the stretch engine (clamped into the range); a grid count-in anchors
    // at the section start where the offset was measured.
    stopClassicSources();
    applyGains();

    const parked = state.classic.position || 0;
    let offset = state.range ? state.range.start : 0;
    if (!hasGridAlign) {
        if (state.range) {
            if (parked >= state.range.start && (state.range.end == null || parked < state.range.end)) offset = parked;
        } else if (parked > 0 && parked < state.classic.duration - 0.05) {
            offset = parked;
        }
    } else {
        offset = gridEntry + align.skipSeconds;
    }
    const when = ctx.currentTime + 0.05 + align.delaySeconds;
    if (hasCountIn) {
        scheduleClicks(ctx, ctx.currentTime + 0.05);
    }
    startClassicSources(offset, when);
}

// Start playback at (or safely after) a SPECIFIC shared-context time and return the ctx time the
// MUSIC begins, so a synchronised recorder can align the take to it (RecordOverStemsSyncPlan.md).
// A configured count-in applies here the same way it applies to play() (MultiTrackRecordingPlan.md
// §5.3): the clicks precede the returned instant, which stays the music start — the sync trim
// anchors the take to the music, never the clicks. The grid alignment's skip-forward is disabled
// (maxSkipSeconds 0): the take's sample 0 must be the FILE's start instant, or the recorded row
// would land shifted against the song by the skipped lead; the early-start half of the alignment
// (a pickup sounding under the closing clicks) keeps that invariant and stays on. Falls back to an
// immediate start for the classic engine. Returns null if nothing loaded.
export async function playAt(ctxStartTime) {
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    if (state.stems.length === 0) return null;

    cancelCountIn();
    const hasCountIn = state.countIn.beats > 0;
    // Clicks need the same scheduling margin play() gives them; the bare sync start keeps its
    // tight lead. Never schedule in the past either way.
    const startAt = Math.max(ctxStartTime, ctx.currentTime + (hasCountIn ? 0.08 : 0.02));
    const align = hasCountIn
        ? countInCore.countInMusicAlignment(state.countIn, state.tempoRatio, 0)
        : { delaySeconds: 0, skipSeconds: 0 };
    if (hasCountIn) {
        scheduleClicks(ctx, startAt);
    }
    const musicAt = startAt + align.delaySeconds;

    if (state.engine === 'stretch') {
        startStretchAt(musicAt);
        return musicAt;
    }

    // Classic fallback: sources start at the scheduled ctx time.
    stopClassicSources();
    applyGains();
    startClassicSources(state.range ? state.range.start : 0, musicAt);
    return musicAt;
}

export function stop() {
    stopInternal();
}

// Pause: halt playback but KEEP the playhead where it is, so the next play resumes from here (stop()
// rewinds to the section/track start; this is its counterpart). Stretch engine: deactivate the
// schedule at the CURRENT input so the deferred re-play starts there, leaving state.stretch.position
// untouched. Classic engine: stopClassicSources() already freezes the derived position before tearing
// the sources down, so it pauses in place by construction. The C# transport re-seeks to this position
// on the next Start (via _pendingSeek), so this is engine-side belt-and-suspenders that also keeps the
// live playhead honest between pause and resume.
export function pause() {
    cancelCountIn();
    health.end(); // wobble monitor (#77) — quiet on a normal pause
    if (state.engine === 'stretch' && state.stretch.node) {
        state.stretch.playing = false;
        state.stretch.holdEndCheckUntil = 0;
        const at = state.stretch.position ?? (state.range ? state.range.start : 0);
        state.stretch.position = at;
        applyStretchSchedule({ active: false, input: at });
        return;
    }
    stopClassicSources();
}

function stopInternal() {
    cancelCountIn();
    health.end(); // wobble monitor (#77) — quiet on a normal stop
    if (state.engine === 'stretch' && state.stretch.node) {
        state.stretch.playing = false;
        state.stretch.holdEndCheckUntil = 0;
        const startAt = state.range ? state.range.start : 0;
        state.stretch.position = startAt;
        applyStretchSchedule({ active: false, input: startAt });
        return;
    }
    stopClassicSources();
}

function disposeStems() {
    stopClassicSources();
    teardownStretchGraph();
    for (const stem of state.stems) {
        if (stem.gainNode) {
            try { stem.gainNode.disconnect(); } catch { /* ignore */ }
        }
        disconnectStemOutput(stem); // panNode + any dual-mix sends
    }
    // The buses go with the graph; state.dualMix itself survives the reload — the next load's
    // graph build rebuilds them against the new engine's fan-in.
    engineCommon.teardownDualBuses(state);
    state.stems = [];
    state.solo = [];
    state.classic.duration = 0;
    state.classic.position = 0;
    state.engine = 'none';
}

export function setMuted(id, muted) {
    const stem = state.stems.find(s => s.id === id);
    if (stem) {
        stem.muted = muted;
        applyGains();
    }
}

// Multi-solo: pass the full set of soloed stem ids (empty array = none soloed). The waveform + audio
// then reflect exactly this set. Only ids that match a loaded stem are kept.
export function setSolo(ids) {
    const loaded = new Set(state.stems.map(s => s.id));
    state.solo = Array.isArray(ids) ? ids.filter(id => loaded.has(id)) : [];
    applyGains();
}

export function setLoop(start, end, loop) {
    cancelPendingCountIn(); // schedule() below would pop the deferred start out from under the clicks
    state.range = start == null ? null : { start, end, loop };
    if (state.engine === 'stretch' && state.stretch.node) {
        // Re-assert loop points; jump into the window if we're before it.
        const jump = state.range && state.stretch.position < state.range.start
            ? { input: state.range.start }
            : {};
        if (jump.input != null) state.stretch.position = jump.input;
        applyStretchSchedule(jump);
    }
}

// Move the playhead, keeping all stems in sync. Stretch engine: re-schedule with the new input
// WITHOUT an `active` flag, so schedule() preserves the play/pause state (same trick setLoop uses).
// Classic engine has no per-source seek, so restart the buffer sources at the new offset if playing.
export function seek(seconds) {
    // A seek abandons a pending count-in: the schedule() below pops the deferred start anyway,
    // so the clicks must not keep firing over the seeked music.
    cancelPendingCountIn();
    const total = getDuration();
    const target = Math.max(0, total > 0 ? Math.min(seconds, total) : seconds);

    if (state.engine === 'stretch' && state.stretch.node) {
        state.stretch.position = target;
        engineCommon.seedSkipScan(state, target);
        applyStretchSchedule({ input: target });
        return;
    }

    // Classic fallback: buffer sources can't be repositioned, so re-start them from the offset.
    const wasPlaying = state.classic.playing;
    if (wasPlaying) stopClassicSources(); // freezes position first — overwrite with the target below
    state.classic.position = target;
    engineCommon.seedSkipScan(state, target);
    if (wasPlaying) {
        applyGains();
        startClassicSources(target, state.ctx.currentTime + 0.02);
    }
}

export function setSkipMarks(marks) {
    engineCommon.setSkipMarks(state, marks, getPosition());
}

// Independent tempo and pitch. Stretch engine: both in one pass on the shared node (pitch
// preserved at any tempo). Classic fallback: per-source playbackRate (detunes!) + granular pitch.
export function setTempoAndPitch(tempoRatio, pitchSemitones) {
    cancelPendingCountIn(); // schedule() below would pop the deferred start out from under the clicks
    // The classic playhead is derived as elapsed × ratio — freeze it under the OLD ratio and
    // re-anchor before the ratio changes, or the whole run so far gets rescaled retroactively.
    if (state.engine === 'classic' && state.classic.playing && state.ctx) {
        state.classic.startedFrom = classicPosition();
        state.classic.startedAt = state.ctx.currentTime;
        state.classic.position = state.classic.startedFrom;
    }
    state.tempoRatio = tempoRatio > 0 ? tempoRatio : 1;
    state.pitchSemitones = pitchSemitones || 0;

    if (state.engine === 'stretch' && state.stretch.node) {
        // #62: capture the state at a tempo/pitch CHANGE — this is when the user hears the "pitch
        // fluctuates up/down" wobble. Logs the new ratio + whether a schedule is applied while playing.
        try {
            const ctx = state.ctx;
            console.warn(`[stems-diag] setTempoAndPitch: tempo=${state.tempoRatio.toFixed(4)} ` +
                `pitchSemis=${state.pitchSemitones} mode=${predictedNodeMode()} ` +
                `playing=${state.stretch.playing} ` +
                `pos=${(state.stretch.position ?? 0).toFixed(3)} now=${ctx ? ctx.currentTime.toFixed(3) : '?'}`);
        } catch { /* diag never breaks playback */ }
        applyStretchSchedule({});
        return;
    }

    for (const stem of state.stems) {
        if (stem.source) stem.source.playbackRate.value = state.tempoRatio;
    }
    applyClassicPitch();
}

// L/R balance of the whole stem mix, -1 (left) … 0 (center) … +1 (right).
export function setPan(pan) {
    engineCommon.setMasterPan(state, pan);
}

// Count-in settings — semantics live in countInCore.clampCountIn (the one statement of the
// beats/entryBeats/secondsPerBeat/firstBeatOffset contract, shared with the track player).
export function setCountIn(beats, entryBeats, secondsPerBeat, firstBeatOffsetSeconds) {
    state.countIn = countInCore.clampCountIn(beats, entryBeats, secondsPerBeat, firstBeatOffsetSeconds);
}

export function isPlaying() {
    return state.engine === 'stretch' ? state.stretch.playing : state.classic.playing;
}

export function stemLabels() {
    return state.stems.map(s => ({ id: s.id, label: s.label, muted: s.muted }));
}

export function getDuration() {
    return state.engine === 'stretch' ? state.stretch.duration : state.classic.duration || 0;
}

export function getPosition() {
    return state.engine === 'stretch' ? state.stretch.position : classicPosition();
}

// ---------------------------------------------------------------------------------------------
// Mix export (realtime bounce): play the WHOLE track once through the LIVE mix graph while a stereo
// capture node on the master panner records the output. Because it taps the exact graph the user
// hears, the result IS the mix — every per-stem volume/pan/mute-solo, master pan, tempo, and pitch are
// captured with no second graph to keep in sync. (The count-in click is deliberately NOT in the export:
// renderMix calls cancelCountIn() — an exported file is the music, not a practice run.) Runs in REAL
// TIME (a 4-min song takes ~4 min, longer when slowed by tempo). Whole track, at the CURRENT tempo/pitch.
// ---------------------------------------------------------------------------------------------

let mixCaptureModuleLoaded = false;

// Set by cancelMixRender() to abort an in-flight bounce. The poll loop below ends on it and renderMix
// returns null (no partial WAV produced), so a cancel leaves NO artifact — the C# side then also has
// nothing to write. Reset at the start of each render.
let mixAborted = false;

// The last encoded mix WAV bytes, awaiting hand-off to C# (mirrors takeWavBytes). A module-level holder
// so the (potentially large) byte array is fetched once via mixWavBytes() and freed on hand-off (or on
// cancel — see cancelMixRender). Declared here, above cancelMixRender, so that reference is unambiguous.
let lastMixWav = null;

// Abort an in-flight mix render. Idempotent; safe to call when nothing is rendering. Also drops any
// already-encoded-but-not-handed-off WAV bytes so a cancel can't leave tens of MB pinned in this
// module until the next export (renderMix returns null on abort, so C# never calls mixWavBytes()).
export function cancelMixRender() {
    mixAborted = true;
    lastMixWav = null;
}

// Cap the capture so a stuck end-detection can never record forever: the song length divided by the
// tempo ratio (tempo stretches REAL time — 70% tempo plays a 240s song over ~343s), plus a margin.
function mixRealSecondsBound() {
    const dur = getDuration();
    const ratio = state.tempoRatio > 0 ? state.tempoRatio : 1;
    return dur > 0 ? dur / ratio + 2 : 0;
}

// Render the current mix to a stereo WAV. Resolves to a Uint8Array of WAV bytes (or null if there is
// nothing to render). Rejects only on a real failure. The bounce is self-contained: it saves and
// restores the loop/position it perturbs, so the visible transport is where it was afterwards.
export async function renderMix() {
    mixAborted = false; // fresh render — clear any leftover cancel from a prior run
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume(); // needs a running context to play + capture
    if (state.engine !== 'stretch' || !state.stretch.node || state.stems.length === 0) {
        return null; // only the stretch engine is a faithful, tempo/pitch-correct source
    }
    const bound = mixRealSecondsBound();
    if (!(bound > 0)) return null;

    // Load the stereo capture worklet once (same path convention as the pitch worklet).
    if (!mixCaptureModuleLoaded) {
        await ctx.audioWorklet.addModule('./_content/MasteryCoach.UI/js/mixCaptureProcessor.js');
        mixCaptureModuleLoaded = true;
    }

    // Save the transport state the bounce perturbs, so we leave the UI where the user had it.
    const savedRange = state.range;
    const savedPosition = state.stretch.position;
    const wasDualMix = state.dualMix;

    const captureNode = new AudioWorkletNode(ctx, 'mix-capture-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    // Tap the master panner (post per-stem gain/pan AND master pan — the whole mix). Pull the capture
    // node through a zero-gain sink so the graph runs it without adding a second audible path.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const master = ensurePanner();
    master.connect(captureNode);
    captureNode.connect(sink).connect(ctx.destination);

    const leftChunks = [];
    const rightChunks = [];
    captureNode.port.onmessage = (e) => {
        if (e.data && e.data.type === 'chunk') {
            leftChunks.push(e.data.left);
            rightChunks.push(e.data.right);
        }
    };

    try {
        // The capture taps the master panner — DOWNSTREAM of the dual buses. Bounce with dual-mix
        // OFF so the shareable file is the normal stereo mix, not monitor-left/room-right with the
        // click hard left (DualMixPlan.md §Mix export interplay). INSIDE the try: a throw anywhere
        // after this must reach the finally's restore, or dual-mix is stranded off while the toggle
        // still shows on. (The restore is a no-op if the flip never ran — setDualMix guards.)
        if (wasDualMix) setDualMix(false);
        // Whole track: drop any loop, rewind to 0, and play from the top at the current tempo/pitch.
        setLoop(null, null, false);
        cancelCountIn(); // no count-in in an export — the file is the music, not a practice run
        seek(0);
        applyGains();
        applyStretchSchedule({ input: 0, active: true });
        state.stretch.holdEndCheckUntil = 0;
        state.stretch.playing = true;

        // Wait until the mix reaches its end (or the user cancels). The end watchdog flips
        // state.stretch.playing false at the media end; poll that, bounded by the real-time cap so a
        // missed end can never hang the export, and by mixAborted so a cancel stops it immediately.
        //
        // TAIL POST-ROLL: the watchdog stops on the stretch node's REPORTED input position, which leads
        // the audio that has actually reached the capture worklet by the node's pipeline latency (input
        // + output) plus the watchdog's own 0.05s guard. If we tore the graph down the instant
        // `playing` went false, the final ~100–200ms of the song (a ringing cymbal, a fade tail) would
        // still be in the DSP pipeline, unrecorded. So once the watchdog says "ended" we keep the graph
        // running and keep collecting chunks for a short post-roll before stopping — the stems are
        // silent past the media end (the node zero-fills), so this only adds real tail + a little
        // trailing digital silence, never anything wrong.
        const TAIL_POSTROLL_SECONDS = 0.35;
        const startedAt = ctx.currentTime;
        let endedAt = 0; // ctx time the watchdog first reported the end (0 = not yet)
        await new Promise(resolve => {
            const tick = () => {
                if (mixAborted) { resolve(); return; }
                if (endedAt === 0 && !state.stretch.playing) {
                    endedAt = ctx.currentTime; // start the post-roll clock
                }
                const postRollDone = endedAt !== 0 && ctx.currentTime - endedAt >= TAIL_POSTROLL_SECONDS;
                const overran = ctx.currentTime - startedAt >= bound + TAIL_POSTROLL_SECONDS;
                if (postRollDone || overran) resolve();
                else setTimeout(tick, 50);
            };
            setTimeout(tick, 50);
        });
    } finally {
        stopInternal();
        try { master.disconnect(captureNode); } catch { /* already gone */ }
        try { captureNode.disconnect(); } catch { /* already gone */ }
        try { sink.disconnect(); } catch { /* already gone */ }
        captureNode.port.onmessage = null;
        // Restore the transport the user had before the bounce.
        state.range = savedRange;
        state.stretch.position = savedPosition;
        applyStretchSchedule({ input: savedPosition, active: false });
        if (wasDualMix) setDualMix(true);
    }

    // Cancelled: drop the captured chunks and produce NOTHING, so no partial WAV/artifact is created.
    if (mixAborted) {
        leftChunks.length = 0;
        rightChunks.length = 0;
        return null;
    }

    // Concatenate the captured chunks into two contiguous channels and encode.
    const total = leftChunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) return null;
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < leftChunks.length; i++) {
        left.set(leftChunks[i], offset);
        right.set(rightChunks[i], offset);
        offset += leftChunks[i].length;
    }
    return encodeWavStereo(left, right, ctx.sampleRate);
}

// Run the render and stash the encoded WAV for mixWavBytes() to hand off (lastMixWav declared up top).
export async function renderMixToBytes() {
    lastMixWav = await renderMix();
    return lastMixWav != null;
}

export function mixWavBytes() {
    const bytes = lastMixWav;
    lastMixWav = null; // release the reference once handed off (don't pin megabytes in the interop store)
    return bytes;
}

// Resolution of the per-stem peak cache computed at load time (before the PCM is freed). Downsampled
// once here so getPeaks — called on every solo change — never touches raw PCM. The cache resolution is
// the HARD ceiling on zoomed-in detail (getPeaks upsamples from it), so match the backing track's
// ~200 buckets/sec (capped) — otherwise a max-zoom stems view draws chunky blocks (user report).
// computePeaks is one linear PCM pass regardless of bucket count, so this costs ~no extra time, only
// memory (per stem, freed with the stem). Duration-aware so short songs don't over-allocate.
function peakBucketsFor(buffer) {
    const seconds = buffer.sampleRate > 0 ? buffer.length / buffer.sampleRate : 0;
    return Math.min(48000, Math.max(2000, Math.floor(seconds * 200)));
}

// Downsample one decoded stem (channels averaged to mono) into { min, max, rms } Float32Arrays.
function computeStemPeaks(buffer, buckets) {
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    return engineCommon.computePeaks(channels, buffer.length, buckets);
}

// Peaks for one stem at load time — from the cached peaks (stretch engine freed the PCM) or, on the
// classic fallback which keeps the buffer, computed on demand. Returns { min, max, rms } or null.
function stemPeaks(stem) {
    if (stem.peaks) return stem.peaks;
    if (stem.buffer) return computeStemPeaks(stem.buffer, peakBucketsFor(stem.buffer));
    return null;
}

// Waveform peaks for the stems view: the soloed stems if any are soloed, else the mix of all stems.
// The per-stem caches are combined into ONE mix envelope at cache resolution (summed mins/maxes,
// root-sum-square rms — the same envelope math for one stem, a solo subset, or the full mix), then
// the window mapping and the flat [min…, max…, rms…] interop layout are delegated to
// engineCommon.resamplePeaksFlat so that contract lives in exactly one place.
// startSeconds/endSeconds (optional) restrict the buckets to a sub-window for a zoomed view.
export function getPeaks(buckets, startSeconds, endSeconds) {
    if (state.stems.length === 0 || buckets < 1) return null;

    const soloSet = new Set(state.solo);
    const soloed = soloSet.size > 0 ? state.stems.filter(s => soloSet.has(s.id)) : state.stems;
    const sources = soloed
        .map(stemPeaks)
        .filter(p => p != null);
    if (sources.length === 0) return null;

    let combined = sources[0];
    if (sources.length > 1) {
        // Stems of a set can differ by a few samples (or, rarely, sample rate), so peakBucketsFor —
        // duration-derived — can hand back DIFFERENT bucket counts per stem. Combine over the SHORTEST
        // source so no read runs past a shorter array: reading p.min[i] past its end yields undefined,
        // which serialized to JSON as `null` and crashed the C# float[] deserialize (user report:
        // "changing to stems … DeserializeUnableToConvertValue … Path $[50]"). The tail beyond the
        // shortest stem is a hair of trailing audio; dropping it from the mix envelope is imperceptible.
        const src = Math.min(...sources.map(p => p.min.length));
        const min = new Float32Array(src), max = new Float32Array(src), rms = new Float32Array(src);
        for (let i = 0; i < src; i++) {
            let lo = 0, hi = 0, sumSq = 0;
            for (const p of sources) {
                lo += p.min[i];   // summing across stems approximates the mix envelope
                hi += p.max[i];
                sumSq += p.rms[i] * p.rms[i];
            }
            // Clamp to [-1,1] — summing stems can exceed unity.
            min[i] = Math.max(-1, lo);
            max[i] = Math.min(1, hi);
            rms[i] = Math.min(1, Math.sqrt(sumSq));
        }
        combined = { min, max, rms };
    }
    return engineCommon.resamplePeaksFlat(combined, buckets, getDuration(), startSeconds, endSeconds);
}
