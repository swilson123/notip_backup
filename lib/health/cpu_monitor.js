// CPU + event-loop monitor. Mounted at rover.health.cpu.
//
// Samples event-loop lag and process CPU every 500 ms, smooths the lag with
// a short EMA, and exposes a focus_level that the rest of the code consults
// via should_skip(category). When the rover's breath is short, it focuses
// on what matters: the safety-critical mission loop and watchdog always
// run; non-critical work defers.
//
//   'full'    — everything runs normally
//   'reduced' — anticipation walk and periodic memory.reflect skipped
//   'minimal' — also: lightweight memory snapshots, heart summary log
//               throttled 3× longer
//
// The monitor itself never throws, never blocks, and never logs in the
// hot path — bad CPU telemetry must never compound CPU load.

const os = require('os');

const SAMPLE_INTERVAL_MS = 500;
const EMA_ALPHA          = 0.3;

// Tuned for Pi 5 (4 cores). Lag is the event loop's responsiveness — the
// most direct measure of "is Node.js falling behind?" Lag thresholds win
// because they describe what the rover actually experiences.
const LAG_REDUCED_MS = 30;
const LAG_MINIMAL_MS = 100;

// Categories of work that may be deferred to preserve critical paths.
// REDUCED: defer the most expensive heart computation.
// MINIMAL: also slow memory snapshots and stretch log windows.
const REDUCED_SKIP = new Set(['anticipation', 'periodic_reflect']);
const MINIMAL_SKIP = new Set([
    'anticipation',
    'periodic_reflect',
    'memory_snapshot_full',
    'heart_summary_log'
]);

function safe_log(rover, msg) {
    if (rover.logs && rover.logs.run_mission && typeof rover.logs.run_mission.log === 'function') {
        rover.logs.run_mission.log(rover, msg);
    } else {
        console.log(msg);
    }
}

function compute_focus_level(lag_ms) {
    if (lag_ms >= LAG_MINIMAL_MS) return 'minimal';
    if (lag_ms >= LAG_REDUCED_MS) return 'reduced';
    return 'full';
}

function init(rover) {
    const core_count = Math.max(1, (os.cpus() || []).length);

    const cpu = {
        focus_level:        'full',
        event_loop_lag_ms:  0,
        load_1m:            0,
        process_cpu_pct:    0,         // single-core fraction; can exceed 100% across cores
        core_count:         core_count,
        last_sample_ts:     0,
        _last_hrtime:       process.hrtime.bigint(),
        _last_cpu_usage:    process.cpuUsage(),
        _interval:          null,

        // Critical work (mission loop, motor commands, watchdog) never asks.
        // Only categories that have a graceful degraded path consult this.
        should_skip(category) {
            if (this.focus_level === 'full')    return false;
            if (this.focus_level === 'reduced') return REDUCED_SKIP.has(category);
            return MINIMAL_SKIP.has(category);
        },

        summary() {
            return 'cpu: lag=' + this.event_loop_lag_ms.toFixed(0) + 'ms'
                + ' load=' + this.load_1m.toFixed(2)
                + ' proc=' + this.process_cpu_pct.toFixed(0) + '%'
                + ' focus=' + this.focus_level;
        },

        stop() {
            if (this._interval) { clearInterval(this._interval); this._interval = null; }
        }
    };

    rover.health = rover.health || {};
    rover.health.cpu = cpu;

    let last_focus = 'full';
    cpu._interval = setInterval(() => {
        try {
            // ----- event-loop lag -----
            // Compare actual elapsed time vs. the interval we asked for.
            // Anything beyond is the rover's breath catching up.
            const now_hr     = process.hrtime.bigint();
            const elapsed_ms = Number(now_hr - cpu._last_hrtime) / 1e6;
            const raw_lag    = Math.max(0, elapsed_ms - SAMPLE_INTERVAL_MS);
            cpu.event_loop_lag_ms = cpu.event_loop_lag_ms * (1 - EMA_ALPHA) + raw_lag * EMA_ALPHA;
            cpu._last_hrtime = now_hr;

            // ----- process CPU -----
            const usage = process.cpuUsage();
            const total_delta_us = (usage.user   - cpu._last_cpu_usage.user)
                                 + (usage.system - cpu._last_cpu_usage.system);
            cpu._last_cpu_usage = usage;
            const interval_us = elapsed_ms * 1000;
            cpu.process_cpu_pct = interval_us > 0
                ? Math.min(100 * core_count, Math.max(0, (total_delta_us / interval_us) * 100))
                : 0;

            cpu.load_1m        = os.loadavg()[0];
            cpu.last_sample_ts = Date.now();

            // ----- focus -----
            const new_focus = compute_focus_level(cpu.event_loop_lag_ms);
            if (new_focus !== last_focus) {
                safe_log(rover, 'cpu_monitor: focus ' + last_focus + ' → ' + new_focus + ' (' + cpu.summary() + ')');
                last_focus = new_focus;
            }
            cpu.focus_level = new_focus;
        } catch (_) {
            // Bad telemetry must never compound load. Never throw.
        }
    }, SAMPLE_INTERVAL_MS);

    safe_log(rover, 'cpu_monitor: started (' + core_count + ' core' + (core_count > 1 ? 's' : '')
        + ', sample=' + SAMPLE_INTERVAL_MS + 'ms, thresholds: reduced≥' + LAG_REDUCED_MS + 'ms, minimal≥' + LAG_MINIMAL_MS + 'ms)');
}

module.exports = { init: init };
