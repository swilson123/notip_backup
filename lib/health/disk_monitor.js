// Disk monitor — long-term memory on the SD card.
// Mounted at white_rabbit.health.disk.
//
// Samples free disk space every 60 s, classifies pressure into one of three
// levels (ample / tight / critical), and on a transition into tight or
// critical calls restore_light() to convert darkness back into light:
//
//   • Memory archives beyond a target count are deleted (the oldest first).
//   • The learning archive is rotated when it grows past a size threshold.
//   • Log folders older than N days are removed.
//
// Sacred memories — the active learning store, current session snapshots —
// are never touched here. They're already curated by their own modules.
// What this monitor releases is the bulk: old logs, old archives, the
// accumulated weight of past sessions.

const fs   = require('fs');
const path = require('path');

const SAMPLE_INTERVAL_MS = 60000;   // disk doesn't change fast; sample modestly

// Thresholds as fraction of partition free. Tighter than memory because
// running out of disk is more catastrophic (can't even write a log line).
const TIGHT_FRACTION    = 0.20;
const CRITICAL_FRACTION = 0.05;

// Aggressiveness knobs for restore_light at each level.
const TIGHT_LOGS_KEEP_DAYS         = 14;
const CRITICAL_LOGS_KEEP_DAYS      = 7;
const TIGHT_MEMORY_KEEP_ARCHIVES   = 25;
const CRITICAL_MEMORY_KEEP_ARCHIVES = 10;
const TIGHT_LEARNING_ROTATE_BYTES   = 5 * 1024 * 1024;   // 5 MB
const CRITICAL_LEARNING_ROTATE_BYTES = 1 * 1024 * 1024;  // 1 MB

function safe_log(white_rabbit, msg) {
    if (white_rabbit.logs && white_rabbit.logs.run_mission && typeof white_rabbit.logs.run_mission.log === 'function') {
        white_rabbit.logs.run_mission.log(white_rabbit, msg);
    } else {
        console.log(msg);
    }
}

function classify(free_pct) {
    if (free_pct < CRITICAL_FRACTION) return 'critical';
    if (free_pct < TIGHT_FRACTION)    return 'tight';
    return 'ample';
}

// Compute the total byte size of a directory tree (best-effort).
function dir_size_bytes(p) {
    let total = 0;
    try {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(p, e.name);
            try {
                if (e.isDirectory())   total += dir_size_bytes(full);
                else if (e.isFile())   total += fs.statSync(full).size;
            } catch (_) { /* skip unreadable */ }
        }
    } catch (_) { /* skip unreadable root */ }
    return total;
}

// Remove logger/<date>/ folders older than max_days. Init_logs does this at
// boot; we do it at runtime when the disk is getting tight, with a tighter
// cutoff than the boot-time 30-day default.
function prune_old_log_folders(max_days) {
    const result = { freed_mb: 0, removed: 0 };
    if (!fs.existsSync('logger')) return result;

    const cutoff = Date.now() - max_days * 24 * 3600 * 1000;
    let entries;
    try { entries = fs.readdirSync('logger'); } catch (_) { return result; }

    for (const name of entries) {
        const d = new Date(name).getTime();
        if (isNaN(d) || d >= cutoff) continue;   // not a dated dir, or recent enough
        const full = path.join('logger', name);
        try {
            const stats = fs.statSync(full);
            if (!stats.isDirectory()) continue;
            const size = dir_size_bytes(full);
            fs.rmSync(full, { recursive: true, force: true });
            result.freed_mb += size / (1024 * 1024);
            result.removed  += 1;
        } catch (_) { /* skip */ }
    }
    return result;
}

function init(white_rabbit) {
    const disk = {
        level:           'ample',
        free_pct:        1.0,
        free_mb:         0,
        total_mb:        0,
        last_sample_ts:  0,
        _interval:       null,

        summary() {
            return 'disk: ' + (this.free_pct * 100).toFixed(0) + '% free ('
                + this.free_mb.toFixed(0) + '/' + this.total_mb.toFixed(0) + ' MB)'
                + ' level=' + this.level;
        },

        // Turn darkness into light — release what is heavy so the white_rabbit has
        // room to keep writing new experiences. Callable manually
        // (white_rabbit.health.disk.restore_light('tight')) or auto-fired on level
        // transitions. Returns { freed_mb, parts: [...] }.
        restore_light(level) {
            const parts = [];
            let total_freed_mb = 0;

            // 1. Trim memory archives down to a tighter count.
            if (white_rabbit.memory && typeof white_rabbit.memory.prune_archives === 'function') {
                const target = (level === 'critical') ? CRITICAL_MEMORY_KEEP_ARCHIVES : TIGHT_MEMORY_KEEP_ARCHIVES;
                const r = white_rabbit.memory.prune_archives(target);
                total_freed_mb += r.freed_mb;
                if (r.removed > 0) parts.push('memory archives −' + r.freed_mb.toFixed(1) + 'MB (' + r.removed + ')');
            }

            // 2. Rotate the learning archive if it has grown beyond threshold.
            if (white_rabbit.learning && typeof white_rabbit.learning.rotate_archive === 'function') {
                const max_bytes = (level === 'critical') ? CRITICAL_LEARNING_ROTATE_BYTES : TIGHT_LEARNING_ROTATE_BYTES;
                const r = white_rabbit.learning.rotate_archive(max_bytes);
                total_freed_mb += r.freed_mb;
                if (r.rotated) parts.push('learning archive rotated −' + r.freed_mb.toFixed(1) + 'MB');
            }

            // 3. Prune old date-named log folders.
            const keep_days = (level === 'critical') ? CRITICAL_LOGS_KEEP_DAYS : TIGHT_LOGS_KEEP_DAYS;
            const r3 = prune_old_log_folders(keep_days);
            total_freed_mb += r3.freed_mb;
            if (r3.removed > 0) parts.push('log folders −' + r3.freed_mb.toFixed(1) + 'MB (' + r3.removed + ' older than ' + keep_days + 'd)');

            const summary = 'disk.restore_light (' + level + '): freed '
                + total_freed_mb.toFixed(1) + 'MB | '
                + (parts.length ? parts.join(', ') : 'nothing to release');
            safe_log(white_rabbit, summary);
            return { freed_mb: total_freed_mb, parts: parts };
        },

        stop() {
            if (this._interval) { clearInterval(this._interval); this._interval = null; }
        }
    };

    white_rabbit.health = white_rabbit.health || {};
    white_rabbit.health.disk = disk;

    let last_level = 'ample';
    disk._interval = setInterval(() => {
        try {
            // fs.statfs added in Node 18.15. The white_rabbit runs on a recent Node;
            // if not available, the call throws and we silently skip a sample.
            if (typeof fs.statfs !== 'function') return;
            fs.statfs('.', (err, stats) => {
                if (err) return;
                const free  = stats.bavail * stats.bsize;
                const total = stats.blocks * stats.bsize;
                disk.free_pct       = total > 0 ? free / total : 1.0;
                disk.free_mb        = free  / (1024 * 1024);
                disk.total_mb       = total / (1024 * 1024);
                disk.last_sample_ts = Date.now();

                const new_level = classify(disk.free_pct);
                if (new_level !== last_level) {
                    safe_log(white_rabbit, 'disk_monitor: level ' + last_level + ' → ' + new_level + ' (' + disk.summary() + ')');
                    if (new_level === 'tight' || new_level === 'critical') {
                        try { disk.restore_light(new_level); } catch (_) {}
                    }
                    last_level = new_level;
                }
                disk.level = new_level;
            });
        } catch (_) {
            // Monitoring must never crash the white_rabbit.
        }
    }, SAMPLE_INTERVAL_MS);

    safe_log(white_rabbit, 'disk_monitor: started (tight<' + (TIGHT_FRACTION * 100) + '%, critical<' + (CRITICAL_FRACTION * 100) + '% free)');
}

module.exports = { init: init };
