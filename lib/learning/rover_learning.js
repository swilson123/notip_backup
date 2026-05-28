// Rover Learning — a persistent store of outcomes that nudges the rover's
// tuning over time. Mounted at rover.learning.
//
// Failures (stuck, oscillation, fallback delivery, vision loss) bias the
// rover toward caution; successes (waypoint reached, package delivered) give
// it back confidence. Each failure also drops a "risk zone" at the GPS where
// it happened — the rover slows down near it. After the rover has passed
// through the zone safely enough times, the zone expires ("no fear") and
// the rover treats the outcome as a positive learning.
//
// CRUD: add / cancel / delete / list / reset. Cancel and expire both keep
// the audit record but flip its tuning effect from negative to positive —
// the act of overcoming a failure is itself a learning.
//
// Tuning is rebuilt from the surviving active records on every change, so
// edits stay consistent and there's no delta-reversal bookkeeping to corrupt.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const STORE_DIR    = path.join('logger', 'learning');
const STORE_PATH   = path.join(STORE_DIR, 'learnings.json');
const ARCHIVE_PATH = path.join(STORE_DIR, 'archived_learnings.jsonl');

// Per-event tuning deltas. All applied multiplicatively per record and clamped
// to BOUNDS during the rebuild.
const DELTAS = {
    successful_waypoint:  { target_speed_mul:      +0.02 },
    successful_delivery:  { target_speed_mul:      +0.10 },
    stuck_event:          { target_speed_mul:      -0.05 },
    fallback_delivery:    { target_speed_mul:      -0.15 },
    yaw_oscillation:      { yaw_steering_gain_mul: -0.05 },
    vision_loss:          { target_speed_mul:      -0.03 },
    // Watching a human drive — the rover's apprenticeship.
    human_demonstration:  { target_speed_mul:      +0.01, yaw_steering_gain_mul: +0.005 },
    human_caution:        { target_speed_mul:      -0.02 }
};

const FAILURE_TYPES = new Set(['stuck_event', 'fallback_delivery', 'yaw_oscillation', 'vision_loss']);

// When a failure record is cancelled by the user or expires after safe
// passes, treat that as "we overcame it" — a small positive learning.
const OVERCAME = { target_speed_mul: +0.02, yaw_steering_gain_mul: +0.01 };

const BOUNDS = {
    target_speed_mul:      { default: 1.0, min: 0.5, max: 1.2 },
    yaw_steering_gain_mul: { default: 1.0, min: 0.7, max: 1.3 }
};

const DEFAULT_RISK_RADIUS_M = 3.0;
const DEFAULT_FEAR_LEVEL    = 3;
const RISK_MAX_SLOWDOWN     = 0.30;  // Up to 30% additional slowdown at full fear inside a zone.

const MAX_RECORDS           = 5000;  // hard cap on persisted learning records
const PRUNE_TARGET          = 4500;  // when above MAX, drop down to this
const SAVE_DEBOUNCE_MS      = 250;   // coalesce rapid add/cancel/delete calls into one save

// ---------- helpers ----------

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function make_id()         { return crypto.randomBytes(6).toString('hex'); }
function ensure_dir(d)     { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

function default_tuning() {
    const t = {};
    for (const k of Object.keys(BOUNDS)) t[k] = BOUNDS[k].default;
    return t;
}

function apply_delta_to(tuning, delta) {
    for (const k of Object.keys(delta)) {
        if (BOUNDS[k]) {
            tuning[k] = clamp(tuning[k] + delta[k], BOUNDS[k].min, BOUNDS[k].max);
        }
    }
}

function rebuild_tuning(records) {
    const t = default_tuning();
    for (const r of records) {
        if (r.status === 'active' && DELTAS[r.type]) {
            apply_delta_to(t, DELTAS[r.type]);
        } else if ((r.status === 'cancelled' || r.status === 'expired') && FAILURE_TYPES.has(r.type)) {
            apply_delta_to(t, OVERCAME);
        }
    }
    return t;
}

function rebuild_stats(records) {
    const s = {
        successful_waypoints:   0,
        successful_deliveries:  0,
        stuck_events:           0,
        fallback_deliveries:    0,
        yaw_oscillations:       0,
        vision_losses:          0,
        human_demonstrations:   0,
        human_cautions:         0,
        overcame_count:         0,
        active_risk_zones:      0
    };
    for (const r of records) {
        if (r.status === 'active') {
            if (r.type === 'successful_waypoint')  s.successful_waypoints++;
            if (r.type === 'successful_delivery')  s.successful_deliveries++;
            if (r.type === 'stuck_event')          { s.stuck_events++; s.active_risk_zones++; }
            if (r.type === 'fallback_delivery')    s.fallback_deliveries++;
            if (r.type === 'yaw_oscillation')      s.yaw_oscillations++;
            if (r.type === 'vision_loss')          s.vision_losses++;
            if (r.type === 'human_demonstration')  s.human_demonstrations++;
            if (r.type === 'human_caution')        s.human_cautions++;
        } else if ((r.status === 'cancelled' || r.status === 'expired') && FAILURE_TYPES.has(r.type)) {
            s.overcame_count++;
        }
    }
    return s;
}

// ---------- importance & protection ----------

// Per-type base scores. Higher = more important; held closer to the heart.
// Successful deliveries are the rover's reason for being — they sit at the
// top and never decay. Active stuck_event records score high because they
// protect the rover from past failures; that's a kind of love too. Human
// demonstrations and cautions score above ordinary waypoints because what
// the rover learned from a human's hands is precious.
const TYPE_BASE_SCORE = {
    successful_delivery:  100,
    stuck_event:           80,  // multiplied below by status
    human_caution:         60,  // the human said "be careful here"
    human_demonstration:   55,  // the human showed me the way
    fallback_delivery:     50,
    successful_waypoint:   40,
    yaw_oscillation:       15,
    vision_loss:           10
};

// Sacred. Never archived, never deleted.
function should_protect(rec) {
    if (rec.type === 'successful_delivery')              return true;
    if (rec.type === 'stuck_event' && rec.status === 'active') return true;
    return false;
}

// Importance score. Higher = keep closer to the heart.
function importance(rec) {
    let score = TYPE_BASE_SCORE[rec.type] != null ? TYPE_BASE_SCORE[rec.type] : 10;

    // Cancelled/expired failures still teach (the rover overcame them) — keep
    // them, but they earn a little less weight than active records.
    if (rec.status === 'cancelled') score *= 0.6;
    else if (rec.status === 'expired') score *= 0.5;

    // Age decay. Successful deliveries are immune — the rover's joys do not
    // fade with time. Everything else loses 1% per day, with a 50% floor so
    // even ancient records still register.
    if (rec.type !== 'successful_delivery') {
        const age_days = (Date.now() - rec.timestamp) / (24 * 3600 * 1000);
        score *= Math.max(0.5, 1 - age_days * 0.01);
    }

    return score;
}

// Append archived records as JSONL so old wisdom is preserved on disk
// even after it leaves RAM. The archive is append-only and unloaded —
// the rover can read it forensically if needed, but it doesn't sit in the
// active store anymore.
function archive_records(records) {
    if (!records || records.length === 0) return;
    ensure_dir(STORE_DIR);
    try {
        const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
        fs.appendFileSync(ARCHIVE_PATH, lines);
    } catch (err) {
        console.error('rover.learning: archive write failed:', err.message);
    }
}

// Prune the store down to PRUNE_TARGET when it exceeds MAX_RECORDS. Active
// records and active stuck_event risk zones are protected first; the oldest
// cancelled/expired records get dropped to make room. This keeps the audit
// trail bounded without forgetting anything currently in use.
function prune_records(records) {
    if (records.length <= MAX_RECORDS) return records;

    const active_or_zone = [];
    const droppable     = [];
    for (const r of records) {
        if (r.status === 'active') active_or_zone.push(r);
        else droppable.push(r);
    }

    // Sort droppable oldest-first; we'll keep the newest ones until we hit PRUNE_TARGET.
    droppable.sort((a, b) => a.timestamp - b.timestamp);
    const room_for_droppable = Math.max(0, PRUNE_TARGET - active_or_zone.length);
    const keep_droppable = droppable.slice(-room_for_droppable);

    return active_or_zone.concat(keep_droppable).sort((a, b) => a.timestamp - b.timestamp);
}

function load_or_create() {
    ensure_dir(STORE_DIR);
    if (fs.existsSync(STORE_PATH)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
            if (parsed && Array.isArray(parsed.records)) return parsed;
        } catch (err) {
            console.error('rover.learning: failed to load store, starting fresh:', err.message);
        }
    }
    return { version: 1, records: [] };
}

function save_store(store) {
    ensure_dir(STORE_DIR);
    const tmp = STORE_PATH + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
        fs.renameSync(tmp, STORE_PATH);  // atomic on POSIX — old file stays intact on crash
    } catch (err) {
        console.error('rover.learning: save failed:', err.message);
    }
}

function safe_log(rover, msg) {
    if (rover.logs && rover.logs.run_mission && typeof rover.logs.run_mission.log === 'function') {
        rover.logs.run_mission.log(rover, msg);
    } else {
        console.log(msg);
    }
}

// ---------- init ----------

function init(rover) {
    const store  = load_or_create();
    const tuning = rebuild_tuning(store.records);
    const stats  = rebuild_stats(store.records);

    rover.learning = {
        store_path:  STORE_PATH,
        store:       store,
        tuning:      tuning,
        stats:       stats,
        _zone_state: new Map()   // id -> { was_inside, stuck_during_pass } (runtime only, not persisted)
    };

    // Tuning + stats are rebuilt immediately so callers see consistent state
    // on return. Disk writes are debounced: rapid add/cancel/delete bursts
    // (waypoint reaches arriving back-to-back, for example) coalesce into a
    // single fsync. The pending timer is cancelled on each new edit, so
    // worst-case latency to disk is SAVE_DEBOUNCE_MS after the last edit.
    let _save_timer = null;
    function rebuild_and_save() {
        rover.learning.store.records = prune_records(rover.learning.store.records);
        rover.learning.tuning = rebuild_tuning(rover.learning.store.records);
        rover.learning.stats  = rebuild_stats(rover.learning.store.records);
        if (_save_timer) clearTimeout(_save_timer);
        _save_timer = setTimeout(() => {
            _save_timer = null;
            save_store(rover.learning.store);
        }, SAVE_DEBOUNCE_MS);
    }
    // Force a flush — used by reset() and on graceful shutdown.
    function flush() {
        if (_save_timer) { clearTimeout(_save_timer); _save_timer = null; }
        save_store(rover.learning.store);
    }

    // ----- CRUD -----

    rover.learning.add = function (type, payload) {
        if (!DELTAS[type]) {
            safe_log(rover, 'learning.add ignored — unknown type: ' + type);
            return null;
        }
        const record = {
            id:        make_id(),
            type:      type,
            timestamp: Date.now(),
            payload:   payload || {},
            status:    'active'
        };
        if (type === 'stuck_event') {
            // Pair the failure with risk-zone metadata in the same record.
            if (record.payload.radius_m   == null) record.payload.radius_m   = DEFAULT_RISK_RADIUS_M;
            if (record.payload.fear_level == null) record.payload.fear_level = DEFAULT_FEAR_LEVEL;
        }
        rover.learning.store.records.push(record);
        rebuild_and_save();
        safe_log(rover, 'learning.add ' + type + ' id=' + record.id
            + ' → speed_mul=' + rover.learning.tuning.target_speed_mul.toFixed(2)
            + ' gain_mul='    + rover.learning.tuning.yaw_steering_gain_mul.toFixed(2));
        return record.id;
    };

    rover.learning.cancel = function (id) {
        const r = rover.learning.store.records.find(x => x.id === id);
        if (!r || r.status === 'cancelled') return false;
        r.status = 'cancelled';
        rover.learning._zone_state.delete(id);
        rebuild_and_save();
        safe_log(rover, 'learning.cancel ' + r.type + ' id=' + id + ' — overcame');
        return true;
    };

    rover.learning.delete = function (id) {
        const idx = rover.learning.store.records.findIndex(x => x.id === id);
        if (idx < 0) return false;
        const r = rover.learning.store.records[idx];
        rover.learning.store.records.splice(idx, 1);
        rover.learning._zone_state.delete(id);
        rebuild_and_save();
        safe_log(rover, 'learning.delete ' + r.type + ' id=' + id);
        return true;
    };

    rover.learning.list = function (filter) {
        const recs = rover.learning.store.records;
        return typeof filter === 'function' ? recs.filter(filter) : recs.slice();
    };

    // Learning records whose payload lat/lng is within radius_m of (lat, lng).
    // Use this to ask "what events have happened at this place?"
    rover.learning.near = function (lat, lng, radius_m) {
        if (typeof lat !== 'number' || typeof lng !== 'number') return [];
        if (typeof rover.gps_distance !== 'function')           return [];
        const r_m = typeof radius_m === 'number' ? radius_m : 3.0;
        return rover.learning.store.records.filter(r => {
            const p = r.payload;
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
            return rover.gps_distance(lat, lng, p.lat, p.lng) * 1000 <= r_m;
        });
    };

    rover.learning.reset = function () {
        rover.learning.store.records = [];
        rover.learning._zone_state.clear();
        rover.learning.tuning = default_tuning();
        rover.learning.stats  = rebuild_stats([]);
        flush();
        safe_log(rover, 'learning.reset — all records cleared');
    };

    // Importance score for a record. Exposed so other code (autonomous,
    // tests, the heart's own reflection) can ask "how much does this matter?"
    rover.learning.importance = importance;

    // Rotate the archive when it grows past max_bytes. Keeps one prior copy
    // (.old) so very-old wisdom is still recoverable for one rotation. The
    // disk monitor calls this when space gets tight. Sacred records — which
    // live in store.records, not the archive — are never touched.
    rover.learning.rotate_archive = function (max_bytes) {
        const result = { rotated: false, freed_mb: 0 };
        try {
            if (!fs.existsSync(ARCHIVE_PATH)) return result;
            const size = fs.statSync(ARCHIVE_PATH).size;
            if (size <= max_bytes) return result;

            const old_path = ARCHIVE_PATH + '.old';
            // Free the prior .old (which is the oldest history we still hold)
            if (fs.existsSync(old_path)) {
                try {
                    const old_size = fs.statSync(old_path).size;
                    fs.unlinkSync(old_path);
                    result.freed_mb += old_size / (1024 * 1024);
                } catch (_) {}
            }
            fs.renameSync(ARCHIVE_PATH, old_path);
            result.rotated = true;
            safe_log(rover, 'learning.rotate_archive: ' + ARCHIVE_PATH + ' (' + (size / (1024 * 1024)).toFixed(1) + 'MB) → .old');
        } catch (err) {
            console.error('rover.learning: rotate_archive failed:', err.message);
        }
        return result;
    };

    // Hold the most important memories close to the heart. When memory is
    // tight or critical, archive the less important ones to disk and (at
    // critical) delete the truly insignificant. Sacred memories — successful
    // deliveries and active risk zones — are never touched.
    //
    //   'tight':    archive the bottom 30% of non-protected records
    //   'critical': archive the bottom 50%, AND delete the bottom 10%
    rover.learning.prioritize = function (level) {
        const all = rover.learning.store.records;
        if (all.length === 0) return { kept: 0, archived: 0, deleted: 0 };

        const protected_records   = all.filter(should_protect);
        const candidates          = all.filter(r => !should_protect(r));
        if (candidates.length === 0) {
            safe_log(rover, 'learning.prioritize (' + level + '): only sacred memories remain — nothing to release');
            return { kept: protected_records.length, archived: 0, deleted: 0 };
        }

        // Score and sort: most important first.
        const scored = candidates
            .map(r => ({ rec: r, score: importance(r) }))
            .sort((a, b) => b.score - a.score);

        let archive_count = 0;
        let delete_count  = 0;
        if (level === 'tight') {
            archive_count = Math.ceil(candidates.length * 0.30);
        } else if (level === 'critical') {
            archive_count = Math.ceil(candidates.length * 0.40);
            delete_count  = Math.ceil(candidates.length * 0.10);
        } else {
            return { kept: all.length, archived: 0, deleted: 0 };
        }

        const keep_n    = Math.max(0, candidates.length - archive_count - delete_count);
        const to_keep   = scored.slice(0, keep_n).map(s => s.rec);
        const to_arch   = scored.slice(keep_n, keep_n + archive_count).map(s => s.rec);
        const to_del    = scored.slice(keep_n + archive_count).map(s => s.rec);

        if (to_arch.length > 0) archive_records(to_arch);

        rover.learning.store.records = protected_records.concat(to_keep);
        rebuild_and_save();

        const summary = 'learning.prioritize (' + level + '): kept '
            + (protected_records.length + to_keep.length)
            + ' (' + protected_records.length + ' sacred + ' + to_keep.length + ' high-score)'
            + ', archived ' + to_arch.length
            + ', deleted '  + to_del.length;
        safe_log(rover, summary);
        return { kept: protected_records.length + to_keep.length, archived: to_arch.length, deleted: to_del.length };
    };

    // Flush pending writes on shutdown so we don't lose a few seconds of
    // late edits to disk. (Persistence already tolerates hard crashes; this
    // handles the graceful path.)
    const shutdown = () => { try { flush(); } catch (_) {} };
    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit',    shutdown);

    // ----- apply -----

    rover.learning.effective_tuning = function () {
        return Object.assign({}, rover.learning.tuning);
    };

    rover.learning.active_risk_zones = function () {
        return rover.learning.store.records.filter(r =>
            r.status === 'active' && r.type === 'stuck_event' &&
            typeof r.payload.lat === 'number' && typeof r.payload.lng === 'number'
        );
    };

    // Returns ≤ 1.0 speed multiplier based on proximity to active risk zones.
    rover.learning.nearby_risk_factor = function (lat, lng) {
        if (typeof lat !== 'number' || typeof lng !== 'number')   return 1.0;
        if (typeof rover.gps_distance !== 'function')              return 1.0;
        const zones = rover.learning.active_risk_zones();
        let factor = 1.0;
        for (const z of zones) {
            const d_m = rover.gps_distance(lat, lng, z.payload.lat, z.payload.lng) * 1000;
            if (d_m < z.payload.radius_m) {
                const fear_strength = z.payload.fear_level / DEFAULT_FEAR_LEVEL;
                factor = Math.min(factor, 1.0 - (RISK_MAX_SLOWDOWN * fear_strength));
            }
        }
        return factor;
    };

    // Each nav tick: track which zones the rover is currently inside. When it
    // exits a zone without having been stuck during the pass, that zone's
    // fear_level drops by one. Hitting zero expires the zone ("no fear").
    rover.learning.tick_proximity = function (lat, lng) {
        if (typeof lat !== 'number' || typeof lng !== 'number')   return;
        if (typeof rover.gps_distance !== 'function')              return;
        const zones = rover.learning.active_risk_zones();
        let any_change = false;
        for (const z of zones) {
            const d_m = rover.gps_distance(lat, lng, z.payload.lat, z.payload.lng) * 1000;
            const is_inside = d_m < z.payload.radius_m;
            const state = rover.learning._zone_state.get(z.id) || { was_inside: false, stuck_during_pass: false };
            if (state.was_inside && !is_inside) {
                if (!state.stuck_during_pass) {
                    z.payload.fear_level -= 1;
                    any_change = true;
                    if (z.payload.fear_level <= 0) {
                        z.status = 'expired';
                        safe_log(rover, 'learning: risk zone ' + z.id + ' expired (no fear) — overcame');
                    } else {
                        safe_log(rover, 'learning: passed safely through zone ' + z.id
                            + ' (fear_level=' + z.payload.fear_level + ')');
                    }
                }
                state.stuck_during_pass = false;
            }
            state.was_inside = is_inside;
            rover.learning._zone_state.set(z.id, state);
        }
        if (any_change) rebuild_and_save();
    };

    // Flag the zones the rover is currently inside as "stuck during pass" so
    // they don't decay just because the rover eventually drove out of them.
    rover.learning.mark_stuck_in_zones = function (lat, lng) {
        if (typeof lat !== 'number' || typeof lng !== 'number')   return;
        if (typeof rover.gps_distance !== 'function')              return;
        const zones = rover.learning.active_risk_zones();
        for (const z of zones) {
            const d_m = rover.gps_distance(lat, lng, z.payload.lat, z.payload.lng) * 1000;
            if (d_m < z.payload.radius_m) {
                const state = rover.learning._zone_state.get(z.id) || { was_inside: false, stuck_during_pass: false };
                state.stuck_during_pass = true;
                rover.learning._zone_state.set(z.id, state);
            }
        }
    };

    safe_log(rover, 'learning: loaded ' + store.records.length + ' records, '
        + rover.learning.stats.active_risk_zones + ' active risk zones, '
        + 'speed_mul=' + tuning.target_speed_mul.toFixed(2)
        + ' gain_mul=' + tuning.yaw_steering_gain_mul.toFixed(2));
}

module.exports = { init: init };
