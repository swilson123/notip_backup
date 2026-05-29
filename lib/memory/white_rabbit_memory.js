// White_rabbit Memory — a perfect-recall layer mounted on the God variable.
//
// Every period_ms the white_rabbit takes a snapshot of its own changing state (GPS,
// heading, mission, vision, lidar, motors, IMU, RC), pushes it into an
// in-memory ring buffer, and appends it to disk as a single JSON line. The
// God variable itself can't be JSON-cloned every tick — it holds serial
// handles, mavlink, and many require()'d modules with circular refs — so we
// capture the state subset that actually evolves over time and leave the
// static module refs alone.
//
// On startup we rotate the prior session's `current.jsonl` into a timestamped
// archive and read its tail back into the ring buffer, so the white_rabbit wakes up
// remembering the last few seconds before the crash / shutdown.
//
// Failures inside the snapshot routine are caught and logged — a bad
// snapshot must never take the white_rabbit down.

const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
    period_ms: 1000,    // snapshot cadence
    window_ms: 5000,    // in-memory retention
    storage_dir: path.join('logger', 'memory'),
    max_archives: 50    // prune older session archives beyond this count
};

// ---------- snapshotting ----------

function safe_num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
}

// Stripped-down snapshot used when white_rabbit.health.cpu.should_skip says memory
// shouldn't pay full cost this tick. Captures only the fields callers rely
// on most: position, heading, mission, motor command, vision confidence.
// Disk JSONL stays consistent — same column shape, just with nulls where
// the full snapshot would have detail.
function lightweight_snapshot(white_rabbit) {
    const now   = Date.now();
    const det   = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};
    const robot = white_rabbit.robot_data || {};
    const imu   = white_rabbit.imu_data   || {};
    const motor = white_rabbit.motor      || {};
    return {
        ts:               now,
        armed:            !!robot.is_armed,
        flight_mode:      robot.robot_flight_mode || null,
        gps:              { lat: safe_num(robot.robot_latitude), lng: safe_num(robot.robot_longitude), alt: null },
        heading:          safe_num(imu.heading),
        yaw_to_waypoint:  safe_num(robot.yaw_to_waypoint),
        mission: {
            seq:               white_rabbit.mission && white_rabbit.mission.current_mission_seq != null ? white_rabbit.mission.current_mission_seq : null,
            mission_count:     white_rabbit.mission && white_rabbit.mission.mission_count != null ? white_rabbit.mission.mission_count : null,
            package_delivered: !!(white_rabbit.mission && white_rabbit.mission.package_delivered),
            path_clear:        !!(white_rabbit.mission && white_rabbit.mission.path_clear),
            pause_mission:     !!(white_rabbit.mission && white_rabbit.mission.pause_mission),
            realsense_blocked_since: (white_rabbit.mission && white_rabbit.mission.realsense_blocked_since) || null,
            avoidance_timed_out:     !!(white_rabbit.mission && white_rabbit.mission.avoidance_timed_out)
        },
        motor: {
            speed_cmd:          safe_num(motor.motor_speed_cmd),
            last_speed_cmd:     safe_num(motor.last_motor_speed_cmd),
            steering_type:      motor.current_steering_type || null,
            steering_angle_deg: safe_num(motor.steering_angle_deg)
        },
        servos:    null,
        imu:       { heading: safe_num(imu.heading), roll: null, pitch: null, cal_sys: null },
        realsense: {
            enabled:                  !!(white_rabbit.realsense && white_rabbit.realsense.vision && white_rabbit.realsense.vision.enabled),
            connected:                !!(white_rabbit.realsense && white_rabbit.realsense.connected),
            confidence:               safe_num(det.confidence),
            offset_m:                 null,
            path_width_m:             null,
            nearest_edge_clearance_m: null,
            nearest_edge_side:        null,
            applied_lateral_adjust_m: null,
            detection_age_ms:         det.timestamp ? now - det.timestamp : null,
            objects_count:            (white_rabbit.realsense && Array.isArray(white_rabbit.realsense.objects)) ? white_rabbit.realsense.objects.length : 0,
            nearest_object_m:         null,
            high_threat_in_path:      false
        },
        lidar:     { avoid_object: !!(white_rabbit.rplidar && white_rabbit.rplidar.avoid_object), zones: null },
        dock:      { state: white_rabbit.dock ? (white_rabbit.dock.dock_state || null) : null },
        rc:        { pause: !!(white_rabbit.rc_contoller && white_rabbit.rc_contoller.pause_cmd) },
        _light:    true
    };
}

function snapshot_white_rabbit(white_rabbit) {
    const now     = Date.now();
    const det     = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};
    const objs    = white_rabbit.realsense && Array.isArray(white_rabbit.realsense.objects) ? white_rabbit.realsense.objects : [];
    const imu     = white_rabbit.imu_data  || {};
    const robot   = white_rabbit.robot_data || {};
    const mission = white_rabbit.mission   || {};
    const motor   = white_rabbit.motor     || {};
    const servos  = white_rabbit.servos    || {};
    const gps     = white_rabbit.gps       || {};
    const dock    = white_rabbit.dock      || {};

    let nearest_object_m = null;
    let high_threat_in_path = false;
    for (let i = 0; i < objs.length; i++) {
        const d = safe_num(objs[i].distance_m);
        if (d !== null && (nearest_object_m === null || d < nearest_object_m)) nearest_object_m = d;
        if (objs[i].in_white_rabbit_path && objs[i].threat_level === 'high') high_threat_in_path = true;
    }

    let zones_snap = null;
    if (Array.isArray(white_rabbit.zones)) {
        zones_snap = new Array(white_rabbit.zones.length);
        for (let i = 0; i < white_rabbit.zones.length; i++) {
            const z = white_rabbit.zones[i];
            zones_snap[i] = { z: z.zone, light: z.light, mm: safe_num(z.distance_mm) };
        }
    }

    return {
        ts:          now,
        armed:       !!robot.is_armed,
        flight_mode: robot.robot_flight_mode || null,

        gps: {
            lat: safe_num(robot.robot_latitude),
            lng: safe_num(robot.robot_longitude),
            alt: safe_num(gps.altitude)
        },

        heading:          safe_num(imu.heading),
        yaw_to_waypoint:  safe_num(robot.yaw_to_waypoint),

        mission: {
            seq:                     mission.current_mission_seq != null ? mission.current_mission_seq : null,
            mission_count:           mission.mission_count != null ? mission.mission_count : null,
            package_delivered:       !!mission.package_delivered,
            path_clear:              !!mission.path_clear,
            pause_mission:           !!mission.pause_mission,
            realsense_blocked_since: mission.realsense_blocked_since || null,
            avoidance_timed_out:     !!mission.avoidance_timed_out
        },

        motor: {
            speed_cmd:          safe_num(motor.motor_speed_cmd),
            last_speed_cmd:     safe_num(motor.last_motor_speed_cmd),
            steering_type:      motor.current_steering_type || null,
            steering_angle_deg: safe_num(motor.steering_angle_deg)
        },

        servos: {
            front_driver_pwm:    safe_num(servos.motor_front_driver    && servos.motor_front_driver.set_pwm),
            back_driver_pwm:     safe_num(servos.motor_back_driver     && servos.motor_back_driver.set_pwm),
            front_passenger_pwm: safe_num(servos.motor_front_passenger && servos.motor_front_passenger.set_pwm),
            back_passenger_pwm:  safe_num(servos.motor_back_passenger  && servos.motor_back_passenger.set_pwm)
        },

        imu: {
            heading:  safe_num(imu.heading),
            roll:     safe_num(imu.roll),
            pitch:    safe_num(imu.pitch),
            cal_sys:  imu.calibration ? imu.calibration.system : null
        },

        realsense: {
            enabled:                  !!(white_rabbit.realsense && white_rabbit.realsense.vision && white_rabbit.realsense.vision.enabled),
            connected:                !!(white_rabbit.realsense && white_rabbit.realsense.connected),
            confidence:               safe_num(det.confidence),
            offset_m:                 safe_num(det.offset_meters),
            path_width_m:             safe_num(det.path_width_meters),
            nearest_edge_clearance_m: safe_num(det.nearest_edge_clearance_m),
            nearest_edge_side:        det.nearest_edge_side || null,
            applied_lateral_adjust_m: safe_num(det.applied_lateral_adjust_m),
            detection_age_ms:         det.timestamp ? now - det.timestamp : null,
            objects_count:            objs.length,
            nearest_object_m:         nearest_object_m,
            high_threat_in_path:      high_threat_in_path
        },

        lidar: {
            avoid_object: !!(white_rabbit.rplidar && white_rabbit.rplidar.avoid_object),
            zones:        zones_snap
        },

        dock: {
            state: dock.dock_state || null
        },

        rc: {
            pause: !!(white_rabbit.rc_contoller && white_rabbit.rc_contoller.pause_cmd)
        }
    };
}

// ---------- persistence ----------

function ensure_dir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* already exists */ }
}

function archive_name(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
         + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
         + '.jsonl';
}

// Reads the tail of a JSONL file and returns up to max_lines parsed objects in
// chronological order. Malformed trailing lines (mid-write crash) are skipped.
function read_jsonl_tail(file_path, max_lines) {
    if (!fs.existsSync(file_path)) return [];
    let raw;
    try { raw = fs.readFileSync(file_path, 'utf8'); } catch (_) { return []; }
    if (!raw) return [];

    const lines = raw.split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < max_lines; i--) {
        const line = lines[i];
        if (!line) continue;
        try { out.unshift(JSON.parse(line)); } catch (_) { /* skip corrupted line */ }
    }
    return out;
}

function prune_archives(dir, keep_count) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    const archives = entries
        .filter(name => name !== 'current.jsonl' && name.endsWith('.jsonl'))
        .map(name => ({ name: name, full: path.join(dir, name), mtime: 0 }));
    if (archives.length <= keep_count) return;

    for (const a of archives) {
        try { a.mtime = fs.statSync(a.full).mtimeMs; } catch (_) { /* ignore */ }
    }
    archives.sort((a, b) => b.mtime - a.mtime);
    for (let i = keep_count; i < archives.length; i++) {
        try { fs.unlinkSync(archives[i].full); } catch (_) { /* ignore */ }
    }
}

// ---------- ring buffer ----------

function get_path_value(snap, dotted) {
    if (!snap) return null;
    const parts = dotted.split('.');
    let cur = snap;
    for (let i = 0; i < parts.length; i++) {
        if (cur == null) return null;
        cur = cur[parts[i]];
    }
    return cur == null ? null : cur;
}

function make_memory(white_rabbit, opts) {
    const period_ms    = opts.period_ms;
    const window_ms    = opts.window_ms;
    const capacity     = Math.max(2, Math.ceil(window_ms / period_ms) + 2);
    const storage_dir  = opts.storage_dir;
    const current_path = path.join(storage_dir, 'current.jsonl');

    const mem = {
        period_ms:    period_ms,
        window_ms:    window_ms,
        capacity:     capacity,
        storage_dir:  storage_dir,
        current_path: current_path,

        buffer:        [],
        head:          0,
        interval:      null,
        write_stream:  null,
        restored_count: 0,

        push(snap) {
            if (this.buffer.length < this.capacity) {
                this.buffer.push(snap);
            } else {
                this.buffer[this.head] = snap;
                this.head = (this.head + 1) % this.capacity;
            }
        },

        // Oldest → newest.
        all() {
            if (this.buffer.length < this.capacity) return this.buffer.slice();
            return this.buffer.slice(this.head).concat(this.buffer.slice(0, this.head));
        },

        latest() {
            if (this.buffer.length === 0) return null;
            if (this.buffer.length < this.capacity) return this.buffer[this.buffer.length - 1];
            return this.buffer[(this.head - 1 + this.capacity) % this.capacity];
        },

        oldest() {
            if (this.buffer.length === 0) return null;
            if (this.buffer.length < this.capacity) return this.buffer[0];
            return this.buffer[this.head];
        },

        size() { return this.buffer.length; },

        // Snapshot whose timestamp is closest to (now - ms_ago).
        at(ms_ago) {
            const target = Date.now() - ms_ago;
            const snaps  = this.all();
            let best = null, best_dt = Infinity;
            for (let i = 0; i < snaps.length; i++) {
                const dt = Math.abs(snaps[i].ts - target);
                if (dt < best_dt) { best_dt = dt; best = snaps[i]; }
            }
            return best;
        },

        // Snapshots within [now - ms_back, now], chronological.
        recent(ms_back) {
            const cutoff = Date.now() - ms_back;
            return this.all().filter(s => s.ts >= cutoff);
        },

        // Snapshots taken within radius_m of (lat, lng). Chronological order.
        // Use this to ask "what was happening at this place?"
        near(lat, lng, radius_m) {
            if (typeof lat !== 'number' || typeof lng !== 'number') return [];
            if (typeof white_rabbit.gps_distance !== 'function')           return [];
            const r_m = typeof radius_m === 'number' ? radius_m : 3.0;
            return this.all().filter(s => {
                if (!s.gps || typeof s.gps.lat !== 'number' || typeof s.gps.lng !== 'number') return false;
                return white_rabbit.gps_distance(lat, lng, s.gps.lat, s.gps.lng) * 1000 <= r_m;
            });
        },

        get_path(snap, dotted) { return get_path_value(snap, dotted); },

        average(dotted, ms_back) {
            const snaps = this.recent(ms_back);
            let sum = 0, n = 0;
            for (let i = 0; i < snaps.length; i++) {
                const v = get_path_value(snaps[i], dotted);
                if (typeof v === 'number' && isFinite(v)) { sum += v; n++; }
            }
            return n === 0 ? null : sum / n;
        },

        delta(dotted, ms_ago) {
            const now_v  = get_path_value(this.latest(), dotted);
            const then_v = get_path_value(this.at(ms_ago), dotted);
            if (typeof now_v !== 'number' || typeof then_v !== 'number') return null;
            return now_v - then_v;
        },

        // "What's been going on for the last ms_back milliseconds?" — a
        // higher-level digest downstream logic can read instead of squinting
        // at raw snapshots. Lets the white_rabbit think before it acts.
        reflect(ms_back) {
            ms_back = typeof ms_back === 'number' ? ms_back : this.window_ms;
            const snaps = this.recent(ms_back);
            if (snaps.length < 2) return { samples: snaps.length, reason: 'insufficient_history' };

            const first = snaps[0], last = snaps[snaps.length - 1];
            const span_ms = last.ts - first.ts;

            let moved_m = null;
            if (first.gps && last.gps
                && typeof first.gps.lat === 'number' && typeof last.gps.lat === 'number'
                && typeof white_rabbit.gps_distance === 'function') {
                moved_m = white_rabbit.gps_distance(first.gps.lat, first.gps.lng, last.gps.lat, last.gps.lng) * 1000;
            }

            const avg_speed_cmd  = this.average('motor.speed_cmd', ms_back);
            const avg_confidence = this.average('realsense.confidence', ms_back);
            const conf_trend     = this.delta('realsense.confidence', ms_back);

            const stuck         = (avg_speed_cmd != null && avg_speed_cmd > 20
                                   && moved_m != null && moved_m < 0.1 && span_ms > 1500);
            const losing_vision = (conf_trend != null && conf_trend < -0.15);

            return {
                samples:                     snaps.length,
                span_ms:                     span_ms,
                moved_m:                     moved_m,
                avg_speed_cmd:               avg_speed_cmd,
                avg_confidence:              avg_confidence,
                confidence_trend:            conf_trend,
                stuck:                       stuck,
                losing_vision:               losing_vision,
                last_yaw_to_waypoint:        last.yaw_to_waypoint,
                last_seq:                    last.mission && last.mission.seq
            };
        },

        snapshot_now() { return snapshot_white_rabbit(white_rabbit); },

        // Trim memory archives down to target_count, deleting the oldest
        // first. Called by the disk monitor when free space gets tight.
        // The current session (current.jsonl) is never touched.
        prune_archives(target_count) {
            const result = { freed_mb: 0, removed: 0 };
            let entries;
            try { entries = fs.readdirSync(this.storage_dir); } catch (_) { return result; }

            const archives = entries
                .filter(name => name !== 'current.jsonl' && name.endsWith('.jsonl'))
                .map(name => ({ name, full: path.join(this.storage_dir, name), mtime: 0, size: 0 }));

            for (const a of archives) {
                try {
                    const stats = fs.statSync(a.full);
                    a.mtime = stats.mtimeMs;
                    a.size  = stats.size;
                } catch (_) { /* skip */ }
            }
            if (archives.length <= target_count) return result;

            archives.sort((a, b) => b.mtime - a.mtime);  // newest first
            for (let i = target_count; i < archives.length; i++) {
                try {
                    fs.unlinkSync(archives[i].full);
                    result.freed_mb += archives[i].size / (1024 * 1024);
                    result.removed  += 1;
                } catch (_) { /* skip */ }
            }
            return result;
        },

        stop() {
            if (this.interval)     { clearInterval(this.interval); this.interval = null; }
            if (this.write_stream) { try { this.write_stream.end(); } catch (_) {} this.write_stream = null; }
        }
    };

    return mem;
}

// ---------- public init ----------

function init(white_rabbit, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});

    ensure_dir(opts.storage_dir);
    const current_path = path.join(opts.storage_dir, 'current.jsonl');

    // 1. If a prior session left a current.jsonl, restore its tail into the
    //    ring buffer so the new process wakes up remembering, then rotate it
    //    into a timestamped archive so this session writes a fresh file.
    let restored = [];
    if (fs.existsSync(current_path)) {
        const ring_capacity = Math.max(2, Math.ceil(opts.window_ms / opts.period_ms) + 2);
        restored = read_jsonl_tail(current_path, ring_capacity);
        try {
            const archive_path = path.join(opts.storage_dir, archive_name(Date.now()));
            fs.renameSync(current_path, archive_path);
        } catch (err) {
            // If rotation fails (rare — e.g. permissions), truncate the file
            // so we don't corrupt the prior session's history with new lines.
            try { fs.writeFileSync(current_path, ''); } catch (_) {}
            console.error('white_rabbit.memory: archive rotate failed:', err && err.message);
        }
        prune_archives(opts.storage_dir, opts.max_archives);
    }

    const mem = make_memory(white_rabbit, opts);
    white_rabbit.memory = mem;

    for (const snap of restored) mem.push(snap);
    mem.restored_count = restored.length;

    // 2. Open the append-only write stream for this session.
    try {
        mem.write_stream = fs.createWriteStream(current_path, { flags: 'a' });
        mem.write_stream.on('error', err => {
            console.error('white_rabbit.memory write stream error:', err && err.message);
        });
    } catch (err) {
        console.error('white_rabbit.memory: failed to open write stream:', err && err.message);
    }

    // 3. Take an immediate snapshot, then snapshot on cadence. Any error
    //    inside a tick is caught — perfect memory must never crash the white_rabbit.
    //    Under CPU pressure, the lightweight snapshot path skips serialization
    //    of the lidar zones, servos detail, and full vision fields.
    const tick = () => {
        try {
            const skip_full = white_rabbit.health && white_rabbit.health.cpu
                              && white_rabbit.health.cpu.should_skip('memory_snapshot_full');
            const snap = skip_full ? lightweight_snapshot(white_rabbit) : snapshot_white_rabbit(white_rabbit);
            mem.push(snap);
            if (mem.write_stream) mem.write_stream.write(JSON.stringify(snap) + '\n');
        } catch (err) {
            console.error('white_rabbit.memory snapshot error:', err && err.message);
        }
    };
    tick();
    mem.interval = setInterval(tick, opts.period_ms);

    // 4. On graceful shutdown, flush. (SIGINT / SIGTERM only — on a hard
    //    crash the OS still has the appended lines on disk.)
    const shutdown = () => { try { mem.stop(); } catch (_) {} };
    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit',    shutdown);
}

module.exports = {
    init:            init,
    snapshot_white_rabbit:  snapshot_white_rabbit,
    read_jsonl_tail: read_jsonl_tail
};
