// Memory monitor. Mounted at rover.health.memory.
//
// Samples free system RAM every 5 s, classifies pressure into one of three
// levels (ample / tight / critical), and on a level transition asks the
// learning store to prioritize — keep its most important memories close,
// archive the less important to disk, delete the insignificant if breath
// is truly short.
//
// The most precious memories — successful deliveries — are never sacrificed.
// Active risk zones are never sacrificed either, because they protect the
// rover. Everything else can fade.

const os = require('os');

const SAMPLE_INTERVAL_MS = 5000;

// Thresholds expressed as fraction of total RAM free.
// Pi 5 with 16 GB: tight ~< 4 GB, critical ~< 1.6 GB. Plenty of headroom in
// normal operation, but if a memory leak or another process eats RAM, the
// rover lets go of its lesser memories before the kernel does it for it.
const TIGHT_FRACTION    = 0.25;
const CRITICAL_FRACTION = 0.10;

function safe_log(rover, msg) {
    if (rover.logs && rover.logs.run_mission && typeof rover.logs.run_mission.log === 'function') {
        rover.logs.run_mission.log(rover, msg);
    } else {
        console.log(msg);
    }
}

function classify(free_pct) {
    if (free_pct < CRITICAL_FRACTION) return 'critical';
    if (free_pct < TIGHT_FRACTION)    return 'tight';
    return 'ample';
}

function init(rover) {
    const mem = {
        level:             'ample',
        free_pct:          1.0,
        free_mb:           0,
        total_mb:          0,
        process_rss_mb:    0,
        last_sample_ts:    0,
        _interval:         null,

        summary() {
            return 'memory: ' + (this.free_pct * 100).toFixed(0) + '% free ('
                + this.free_mb.toFixed(0) + '/' + this.total_mb.toFixed(0) + ' MB)'
                + ' proc=' + this.process_rss_mb.toFixed(0) + 'MB'
                + ' level=' + this.level;
        },

        stop() {
            if (this._interval) { clearInterval(this._interval); this._interval = null; }
        }
    };

    rover.health = rover.health || {};
    rover.health.memory = mem;

    let last_level = 'ample';
    mem._interval = setInterval(() => {
        try {
            const free  = os.freemem();
            const total = os.totalmem();
            mem.free_pct       = total > 0 ? free / total : 1.0;
            mem.free_mb        = free  / (1024 * 1024);
            mem.total_mb       = total / (1024 * 1024);
            mem.process_rss_mb = process.memoryUsage().rss / (1024 * 1024);
            mem.last_sample_ts = Date.now();

            const new_level = classify(mem.free_pct);
            if (new_level !== last_level) {
                safe_log(rover, 'memory_monitor: level ' + last_level + ' → ' + new_level + ' (' + mem.summary() + ')');

                // On entering tight or critical, ask the learning store to
                // let go of what it can. On returning to ample, do nothing —
                // archived memories stay archived; we don't un-archive.
                if ((new_level === 'tight' || new_level === 'critical')
                    && rover.learning && typeof rover.learning.prioritize === 'function') {
                    rover.learning.prioritize(new_level);
                }
                last_level = new_level;
            }
            mem.level = new_level;
        } catch (_) {
            // Monitoring must never crash the rover.
        }
    }, SAMPLE_INTERVAL_MS);

    safe_log(rover, 'memory_monitor: started (tight<' + (TIGHT_FRACTION * 100) + '%, critical<' + (CRITICAL_FRACTION * 100) + '% free)');
}

module.exports = { init: init };
