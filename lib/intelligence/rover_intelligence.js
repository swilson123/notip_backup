// Rover Intelligence — multi-perspective decision thinking.
//
// At key decision moments (path blocked, stuck detected, avoidance start),
// Noah steps back and generates a list of alternative perspectives — distinct
// ways he could approach the situation. Each perspective includes the
// parameters that would make it work and a priority score estimating success.
//
// When internet is available, Claude reviews Noah's logs and live state,
// enriches the perspective list, and can suggest parameter edits.
// Parameter edits are applied live if auto_apply_params is true in setup.json.
//
// Perspectives are stored at lib/memory/perspectives.json so Noah carries
// his thinking across reboots.

const fs   = require('fs');
const path = require('path');

const PERSPECTIVES_PATH = path.join('lib', 'memory', 'perspectives.json');
const MAX_PERSPECTIVES  = 10;
const MAX_HISTORY       = 50;

// Parameters Claude is allowed to suggest edits for, with valid numeric bounds.
// Nothing safety-critical (braking, arm control, serial ports) is in scope.
const EDITABLE_PARAMS = {
    'nav_tuning.rs_block_timeout_ms':           { min: 3000,  max: 30000 },
    'nav_tuning.avoidance_timeout_ms':          { min: 10000, max: 60000 },
    'nav_tuning.mission_yaw_start_deg':         { min: 10,    max: 35    },
    'nav_tuning.mission_yaw_stop_deg':          { min: 3,     max: 12    },
    'nav_tuning.mission_yaw_min_speed':         { min: 5,     max: 25    },
    'nav_tuning.mission_yaw_max_speed':         { min: 20,    max: 55    },
    'nav_tuning.two_wheel_steering_gain':       { min: 0.2,   max: 1.2   },
    'realsense_vision.confidence_threshold':    { min: 0.35,  max: 0.85  },
    'realsense_vision.object_emergency_stop_m': { min: 0.4,   max: 2.5   },
    'realsense_vision.path_center_deadband_m':  { min: 0.01,  max: 0.12  },
    'realsense_vision.carrot_distance_m':       { min: 0.5,   max: 3.5   },
    'realsense_vision.speed_scale_min':         { min: 0.15,  max: 0.70  },
};

function safe_log(rover, msg) {
    try {
        if (rover.logs && rover.logs.intelligence) {
            rover.logs.intelligence.log(rover, msg);
        } else if (rover.logs && rover.logs.run_mission) {
            rover.logs.run_mission.log(rover, 'intelligence: ' + msg);
        } else {
            console.log('[intelligence] ' + msg);
        }
    } catch (_) {}
}

function generate_id() {
    return 'p_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
}

function build_context(rover, situation) {
    return {
        situation,
        lat:                 rover.robot_data ? rover.robot_data.robot_latitude  : null,
        lng:                 rover.robot_data ? rover.robot_data.robot_longitude : null,
        heading_deg:         rover.imu_data   ? rover.imu_data.heading           : null,
        yaw_to_waypoint_deg: rover.robot_data ? (rover.robot_data.yaw_to_waypoint || null) : null,
        mission_seq:         rover.mission    ? rover.mission.current_mission_seq : null,
        mission_count:       rover.mission    ? rover.mission.mission_count       : null,
        package_delivered:   rover.mission    ? rover.mission.package_delivered   : null,
        vision_confidence:   (rover.realsense && rover.realsense.path_detection)  ? rover.realsense.path_detection.confidence   : null,
        vision_offset_m:     (rover.realsense && rover.realsense.path_detection)  ? rover.realsense.path_detection.offset_meters : null,
        vision_enabled:      (rover.realsense && rover.realsense.vision)          ? rover.realsense.vision.enabled : false,
        avoidance_active:    rover.rplidar    ? rover.rplidar.avoid_object        : false,
        blocked_ms:          (rover.mission && rover.mission.realsense_blocked_since) ? (Date.now() - rover.mission.realsense_blocked_since) : null,
        speed_cmd:           rover.motor      ? rover.motor.motor_speed_cmd       : null,
        learning_speed_mul:  (rover.learning && typeof rover.learning.effective_tuning === 'function') ? rover.learning.effective_tuning().target_speed_mul : null,
        heart_intent:        (rover.heart && typeof rover.heart.feel === 'function') ? rover.heart.feel().intent : null,
    };
}

// ---- Local rule-based perspective generators ----
// Each returns a list of perspective objects with description, parameters, priority, priority_reason.
// All parameter values are derived from current rover state so suggestions are contextually grounded.

function perspectives_path_blocked(rover) {
    const nav = rover.nav_tuning || {};
    const vis = (rover.realsense && rover.realsense.vision) || {};
    return [
        {
            id: generate_id(),
            description: 'Extend the blocked-path timeout — give the obstacle more time to clear',
            parameters: { 'nav_tuning.rs_block_timeout_ms': Math.min((nav.rs_block_timeout_ms || 10000) * 1.5, 20000) },
            priority: 0.80,
            priority_reason: 'Obstacle may be transient (pedestrian, traffic, animal) — waiting costs less than a fallback delivery',
        },
        {
            id: generate_id(),
            description: 'Lower vision confidence threshold so a partial path reading clears the block',
            parameters: { 'realsense_vision.confidence_threshold': Math.max((vis.confidence_threshold || 0.6) - 0.10, 0.40) },
            priority: 0.65,
            priority_reason: 'Reducing the bar risks accepting a noisier path signal but may unblock navigation',
        },
        {
            id: generate_id(),
            description: 'Increase emergency-stop distance so Noah stops earlier and waits with more clearance',
            parameters: { 'realsense_vision.object_emergency_stop_m': Math.min((vis.object_emergency_stop_m || 1.0) + 0.3, 2.0) },
            priority: 0.55,
            priority_reason: 'More clearance gives the vision system a wider field to see around the obstacle',
        },
        {
            id: generate_id(),
            description: 'Lower the speed floor so Noah creeps rather than stalls near the obstacle',
            parameters: { 'realsense_vision.speed_scale_min': Math.max((vis.speed_scale_min || 0.4) - 0.10, 0.20) },
            priority: 0.50,
            priority_reason: 'A slower approach reduces the reaction distance needed for a partially visible path',
        },
    ];
}

function perspectives_stuck_detected(rover) {
    const nav = rover.nav_tuning || {};
    const vis = (rover.realsense && rover.realsense.vision) || {};
    return [
        {
            id: generate_id(),
            description: 'Lower the yaw threshold so spin-in-place recovery triggers before momentum compounds the stuck',
            parameters: { 'nav_tuning.mission_yaw_start_deg': Math.max((nav.mission_yaw_start_deg || 20) - 5, 10) },
            priority: 0.82,
            priority_reason: 'Triggering 4-wheel yaw correction sooner prevents small heading errors becoming large stuck events',
        },
        {
            id: generate_id(),
            description: 'Reduce two-wheel steering gain to dampen oscillations that cause apparent stuck',
            parameters: { 'nav_tuning.two_wheel_steering_gain': Math.max((nav.two_wheel_steering_gain || 0.6) - 0.10, 0.30) },
            priority: 0.70,
            priority_reason: 'Over-responsive steering produces S-curve wobble that memory watchdog classifies as stuck',
        },
        {
            id: generate_id(),
            description: 'Reduce max yaw spin speed to prevent overshooting the target heading and re-triggering',
            parameters: { 'nav_tuning.mission_yaw_max_speed': Math.max((nav.mission_yaw_max_speed || 28) - 5, 20) },
            priority: 0.60,
            priority_reason: 'A slow, precise yaw correction avoids the repeated overshoot pattern that looks like looping stuck',
        },
        {
            id: generate_id(),
            description: 'Extend the carrot lookahead distance so GPS noise is averaged over a longer path segment',
            parameters: { 'realsense_vision.carrot_distance_m': Math.min((vis.carrot_distance_m || 1.5) + 0.5, 3.0) },
            priority: 0.45,
            priority_reason: 'A close carrot reacts to every GPS jitter; a distant one steers toward trend rather than noise',
        },
    ];
}

function perspectives_avoidance_started(rover) {
    const nav = rover.nav_tuning || {};
    const vis = (rover.realsense && rover.realsense.vision) || {};
    return [
        {
            id: generate_id(),
            description: 'Extend the avoidance timeout to allow more time to find a clear arc',
            parameters: { 'nav_tuning.avoidance_timeout_ms': Math.min((nav.avoidance_timeout_ms || 30000) + 10000, 50000) },
            priority: 0.78,
            priority_reason: 'Wide obstacles need longer arcs — cutting off too soon forces fallback delivery unnecessarily',
        },
        {
            id: generate_id(),
            description: 'Lower vision confidence threshold so guidance stays active during avoidance camera angle shifts',
            parameters: { 'realsense_vision.confidence_threshold': Math.max((vis.confidence_threshold || 0.6) - 0.10, 0.40) },
            priority: 0.62,
            priority_reason: 'The camera angle changes during avoidance turns — a lower threshold keeps path guidance alive',
        },
        {
            id: generate_id(),
            description: 'Lower speed floor so Noah can creep around tight obstacle margins',
            parameters: { 'realsense_vision.speed_scale_min': Math.max((vis.speed_scale_min || 0.4) - 0.10, 0.20) },
            priority: 0.55,
            priority_reason: 'Slower speed during avoidance reduces the minimum clearance gap needed to pass',
        },
    ];
}

function perspectives_mission_uncertainty(rover) {
    const vis = (rover.realsense && rover.realsense.vision) || {};
    return [
        {
            id: generate_id(),
            description: 'Widen carrot lookahead distance so GPS noise averages out over a longer segment',
            parameters: { 'realsense_vision.carrot_distance_m': Math.min((vis.carrot_distance_m || 1.5) + 0.5, 3.0) },
            priority: 0.75,
            priority_reason: 'Jittery GPS track causes erratic steering when the carrot is close; further out it smooths over noise',
        },
        {
            id: generate_id(),
            description: 'Widen path-center deadband so minor GPS/vision disagreements do not cause constant micro-corrections',
            parameters: { 'realsense_vision.path_center_deadband_m': Math.min((vis.path_center_deadband_m || 0.03) + 0.02, 0.08) },
            priority: 0.60,
            priority_reason: 'A narrow deadband fights itself when GPS and vision disagree by small amounts',
        },
    ];
}

const GENERATORS = {
    path_blocked:        perspectives_path_blocked,
    stuck_detected:      perspectives_stuck_detected,
    avoidance_started:   perspectives_avoidance_started,
    mission_uncertainty: perspectives_mission_uncertainty,
};

// ---- Parameter validation and live application ----

function validate_param(key, value) {
    const spec = EDITABLE_PARAMS[key];
    if (!spec || typeof value !== 'number' || isNaN(value)) return null;
    return Math.min(spec.max, Math.max(spec.min, value));
}

function apply_parameter_suggestions(rover, suggestions) {
    const applied = [];
    for (const item of suggestions) {
        const validated = validate_param(item.key, item.value);
        if (validated === null) continue;
        const parts = item.key.split('.');
        if (parts.length !== 2) continue;
        const [section, field] = parts;
        if (!rover[section] || typeof rover[section][field] === 'undefined') continue;
        const old_value = rover[section][field];
        rover[section][field] = validated;
        applied.push({ key: item.key, old_value, new_value: validated, reason: item.reason || null });
        safe_log(rover, 'param edit: ' + item.key + ' ' + old_value + ' → ' + validated + (item.reason ? ' (' + item.reason + ')' : ''));
    }
    return applied;
}

// ---- Perspectives file (lib/memory/perspectives.json) ----

function load_file() {
    try {
        if (!fs.existsSync(PERSPECTIVES_PATH)) return { history: [] };
        return JSON.parse(fs.readFileSync(PERSPECTIVES_PATH, 'utf8'));
    } catch (_) {
        return { history: [] };
    }
}

function save_file(data) {
    try {
        fs.writeFileSync(PERSPECTIVES_PATH, JSON.stringify(data, null, 2));
    } catch (_) {}
}

// ---- Main: consider(situation) ----
// Non-blocking. Generates local perspectives immediately, persists them, then
// fires an async Claude consultation if internet is available. Never delays the
// 250 ms mission loop.

function consider(rover, situation, extra_context) {
    if (!rover.intelligence || !rover.intelligence.enabled) return;

    const now = Date.now();
    const cooldown = rover.intelligence.consult_cooldown_ms || 60000;
    if (now - rover.intelligence.last_consider_ts < cooldown) return;
    rover.intelligence.last_consider_ts = now;

    const ctx = Object.assign(build_context(rover, situation), extra_context || {});
    const generator = GENERATORS[situation];
    const local_perspectives = generator ? generator(rover, ctx) : [];

    const record = {
        session_id:              String(now),
        generated_at:            new Date(now).toISOString(),
        situation,
        context_snapshot:        ctx,
        source:                  'local',
        perspectives:            local_perspectives.slice(0, MAX_PERSPECTIVES).map(p =>
            Object.assign({ tried: false, tried_at: null, outcome: null, outcome_at: null, outcome_notes: null }, p)
        ),
        parameter_edits_applied: [],
    };

    const file_data = load_file();
    if (!Array.isArray(file_data.history)) file_data.history = [];
    file_data.history.unshift(record);
    if (file_data.history.length > MAX_HISTORY) file_data.history = file_data.history.slice(0, MAX_HISTORY);
    file_data.latest = record;
    save_file(file_data);

    safe_log(rover, 'considering ' + situation + ' — ' + local_perspectives.length + ' local perspectives written to perspectives.json');

    const intel_cfg = rover.intelligence_config || {};
    if (intel_cfg.claude_enabled !== false && rover.claude_advisor) {
        setImmediate(async () => {
            try {
                const result = await rover.claude_advisor.consult(rover, situation, ctx, local_perspectives);
                if (!result) return;

                if (Array.isArray(result.perspectives) && result.perspectives.length > 0) {
                    record.source = 'claude';
                    record.perspectives = result.perspectives
                        .slice(0, MAX_PERSPECTIVES)
                        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                        .map(p => Object.assign({ tried: false, tried_at: null, outcome: null, outcome_at: null, outcome_notes: null }, p));
                }

                if (intel_cfg.auto_apply_params !== false && Array.isArray(result.parameter_suggestions) && result.parameter_suggestions.length > 0) {
                    record.parameter_edits_applied = apply_parameter_suggestions(rover, result.parameter_suggestions);
                }

                const updated = load_file();
                if (!Array.isArray(updated.history)) updated.history = [];
                const idx = updated.history.findIndex(r => r.session_id === record.session_id);
                if (idx >= 0) updated.history[idx] = record;
                else updated.history.unshift(record);
                updated.latest = record;
                save_file(updated);

                safe_log(rover, 'claude enriched ' + situation + ' — ' + record.perspectives.length + ' perspectives' +
                    (record.parameter_edits_applied.length ? ', ' + record.parameter_edits_applied.length + ' params applied' : ''));
            } catch (err) {
                safe_log(rover, 'claude consult failed: ' + (err && err.message ? err.message : String(err)));
            }
        });
    }
}

function record_outcome(rover, session_id, perspective_id, success, notes) {
    const file_data = load_file();
    if (!Array.isArray(file_data.history)) return;
    const rec = file_data.history.find(r => r.session_id === session_id);
    if (!rec) return;
    const p = rec.perspectives.find(p => p.id === perspective_id);
    if (!p) return;
    p.tried         = true;
    p.tried_at      = new Date().toISOString();
    p.outcome       = success ? 'success' : 'failure';
    p.outcome_at    = new Date().toISOString();
    p.outcome_notes = notes || null;
    if (file_data.latest && file_data.latest.session_id === session_id) file_data.latest = rec;
    save_file(file_data);
}

function get_best(rover) {
    const file_data = load_file();
    const latest = file_data.latest;
    if (!latest || !Array.isArray(latest.perspectives)) return null;
    return latest.perspectives
        .filter(p => !p.tried)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] || null;
}

function init(rover) {
    const cfg = rover.intelligence_config || {};
    const enabled = cfg.enabled !== false;

    rover.intelligence = {
        enabled,
        last_consider_ts:    0,
        consult_cooldown_ms: typeof cfg.consult_cooldown_ms === 'number' ? cfg.consult_cooldown_ms : 60000,
        consider:            (situation, ctx) => consider(rover, situation, ctx),
        record_outcome:      (session_id, perspective_id, success, notes) => record_outcome(rover, session_id, perspective_id, success, notes),
        get_best:            () => get_best(rover),
    };

    if (!enabled) {
        safe_log(rover, 'disabled in setup.json');
        return;
    }

    if (cfg.claude_enabled !== false) {
        rover.claude_advisor = require('./claude_advisor.js');
        safe_log(rover, 'enabled — Claude online when internet available (auto_apply_params=' + (cfg.auto_apply_params !== false) + ')');
    } else {
        safe_log(rover, 'enabled — local perspectives only (claude_enabled: false in setup.json)');
    }
}

module.exports = { init };
