// White_rabbit Intelligence — multi-perspective decision thinking.
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
const DEFAULT_TRIAL_TIMEOUT_MS = 120000;

const SITUATION_ALIASES = {
    fallback_delivery_triggered: 'path_blocked',
    fallback_delivery: 'path_blocked',
    obstacle_blocked: 'path_blocked'
};

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

function safe_log(white_rabbit, msg) {
    try {
        if (white_rabbit.logs && white_rabbit.logs.intelligence) {
            white_rabbit.logs.intelligence.log(white_rabbit, msg);
        } else if (white_rabbit.logs && white_rabbit.logs.run_mission) {
            white_rabbit.logs.run_mission.log(white_rabbit, 'intelligence: ' + msg);
        } else {
            console.log('[intelligence] ' + msg);
        }
    } catch (_) {}
}

function say_intelligence_status(white_rabbit, msg, urgent) {
    try {
        if (white_rabbit.voice && typeof white_rabbit.voice.say === 'function' && msg) {
            white_rabbit.voice.say(msg, !!urgent);
        }
    } catch (_) {}
}

function brief_perspective_text(description) {
    if (!description || typeof description !== 'string') return 'testing a new perspective';
    const cleaned = description.replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'testing a new perspective';
    return cleaned.length > 72 ? cleaned.slice(0, 69) + '...' : cleaned;
}

function generate_id() {
    return 'p_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
}

function canonical_situation(situation) {
    return SITUATION_ALIASES[situation] || situation;
}

function build_context(white_rabbit, situation) {
    return {
        situation,
        lat:                 white_rabbit.robot_data ? white_rabbit.robot_data.robot_latitude  : null,
        lng:                 white_rabbit.robot_data ? white_rabbit.robot_data.robot_longitude : null,
        heading_deg:         white_rabbit.get_heading ? white_rabbit.get_heading(white_rabbit)  : null,
        yaw_to_waypoint_deg: white_rabbit.robot_data ? (white_rabbit.robot_data.yaw_to_waypoint || null) : null,
        mission_seq:         white_rabbit.mission    ? white_rabbit.mission.current_mission_seq : null,
        mission_count:       white_rabbit.mission    ? white_rabbit.mission.mission_count       : null,
        package_delivered:   white_rabbit.mission    ? white_rabbit.mission.package_delivered   : null,
        vision_confidence:   (white_rabbit.realsense && white_rabbit.realsense.path_detection)  ? white_rabbit.realsense.path_detection.confidence   : null,
        vision_offset_m:     (white_rabbit.realsense && white_rabbit.realsense.path_detection)  ? white_rabbit.realsense.path_detection.offset_meters : null,
        vision_enabled:      (white_rabbit.realsense && white_rabbit.realsense.vision)          ? white_rabbit.realsense.vision.enabled : false,
        avoidance_active:    white_rabbit.rplidar    ? white_rabbit.rplidar.avoid_object        : false,
        blocked_ms:          (white_rabbit.mission && white_rabbit.mission.realsense_blocked_since) ? (Date.now() - white_rabbit.mission.realsense_blocked_since) : null,
        speed_cmd:           white_rabbit.motor      ? white_rabbit.motor.motor_speed_cmd       : null,
        learning_speed_mul:  (white_rabbit.learning && typeof white_rabbit.learning.effective_tuning === 'function') ? white_rabbit.learning.effective_tuning().target_speed_mul : null,
        heart_intent:        (white_rabbit.heart && typeof white_rabbit.heart.feel === 'function') ? white_rabbit.heart.feel().intent : null,
    };
}

// ---- Local rule-based perspective generators ----
// Each returns a list of perspective objects with description, parameters, priority, priority_reason.
// All parameter values are derived from current white_rabbit state so suggestions are contextually grounded.

function perspectives_path_blocked(white_rabbit) {
    const nav = white_rabbit.nav_tuning || {};
    const vis = (white_rabbit.realsense && white_rabbit.realsense.vision) || {};
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

function perspectives_stuck_detected(white_rabbit) {
    const nav = white_rabbit.nav_tuning || {};
    const vis = (white_rabbit.realsense && white_rabbit.realsense.vision) || {};
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

function perspectives_avoidance_started(white_rabbit) {
    const nav = white_rabbit.nav_tuning || {};
    const vis = (white_rabbit.realsense && white_rabbit.realsense.vision) || {};
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

function perspectives_mission_uncertainty(white_rabbit) {
    const vis = (white_rabbit.realsense && white_rabbit.realsense.vision) || {};
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

function apply_parameter_suggestions(white_rabbit, suggestions) {
    const applied = [];
    for (const item of suggestions) {
        const validated = validate_param(item.key, item.value);
        if (validated === null) continue;
        const parts = item.key.split('.');
        if (parts.length !== 2) continue;
        const [section, field] = parts;
        if (!white_rabbit[section] || typeof white_rabbit[section][field] === 'undefined') continue;
        const old_value = white_rabbit[section][field];
        white_rabbit[section][field] = validated;
        applied.push({ key: item.key, old_value, new_value: validated, reason: item.reason || null });
        safe_log(white_rabbit, 'param edit: ' + item.key + ' ' + old_value + ' → ' + validated + (item.reason ? ' (' + item.reason + ')' : ''));
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

function collect_history_stats(file_data, situation, description) {
    let trials = 0;
    let successes = 0;
    if (!file_data || !Array.isArray(file_data.history)) return { trials: 0, successes: 0, success_rate: null };

    for (const rec of file_data.history) {
        if (!rec || rec.situation !== situation || !Array.isArray(rec.perspectives)) continue;
        for (const p of rec.perspectives) {
            if (!p || p.description !== description) continue;
            if (p.outcome === 'success' || p.outcome === 'failure') {
                trials += 1;
                if (p.outcome === 'success') successes += 1;
            }
        }
    }

    return {
        trials,
        successes,
        success_rate: trials > 0 ? (successes / trials) : null
    };
}

function enrich_and_rank_perspectives(file_data, situation, perspectives) {
    return (perspectives || [])
        .slice(0, MAX_PERSPECTIVES)
        .map(p => {
            const base_priority = (typeof p.priority === 'number') ? p.priority : 0.5;
            const stats = collect_history_stats(file_data, situation, p.description);
            const blended = (stats.success_rate === null)
                ? base_priority
                : (base_priority * 0.7 + stats.success_rate * 0.3);
            return Object.assign(
                { tried: false, tried_at: null, outcome: null, outcome_at: null, outcome_notes: null },
                p,
                {
                    historical_trials: stats.trials,
                    historical_success_rate: stats.success_rate,
                    priority_blended: Number(blended.toFixed(4))
                }
            );
        })
        .sort((a, b) => {
            const pa = (typeof a.priority_blended === 'number') ? a.priority_blended : (a.priority || 0);
            const pb = (typeof b.priority_blended === 'number') ? b.priority_blended : (b.priority || 0);
            return pb - pa;
        });
}

function apply_perspective_parameters(white_rabbit, parameters, reason) {
    const applied = [];
    if (!parameters || typeof parameters !== 'object') return applied;

    for (const key of Object.keys(parameters)) {
        const validated = validate_param(key, parameters[key]);
        if (validated === null) continue;
        const parts = key.split('.');
        if (parts.length !== 2) continue;
        const [section, field] = parts;
        if (!white_rabbit[section] || typeof white_rabbit[section][field] === 'undefined') continue;
        const old_value = white_rabbit[section][field];
        white_rabbit[section][field] = validated;
        applied.push({ key, old_value, new_value: validated });
        safe_log(white_rabbit, 'trial edit: ' + key + ' ' + old_value + ' -> ' + validated + (reason ? ' (' + reason + ')' : ''));
    }

    return applied;
}

function rollback_trial_parameters(white_rabbit, applied) {
    if (!Array.isArray(applied)) return;
    for (const item of applied) {
        if (!item || !item.key) continue;
        const parts = item.key.split('.');
        if (parts.length !== 2) continue;
        const [section, field] = parts;
        if (!white_rabbit[section] || typeof white_rabbit[section][field] === 'undefined') continue;
        white_rabbit[section][field] = item.old_value;
        safe_log(white_rabbit, 'trial rollback: ' + item.key + ' -> ' + item.old_value);
    }
}

function mark_perspective_started(session_id, perspective_id) {
    const file_data = load_file();
    if (!Array.isArray(file_data.history)) return;
    const rec = file_data.history.find(r => r.session_id === session_id);
    if (!rec || !Array.isArray(rec.perspectives)) return;
    const p = rec.perspectives.find(x => x.id === perspective_id);
    if (!p) return;
    p.tried = true;
    p.tried_at = new Date().toISOString();
    p.outcome = null;
    p.outcome_at = null;
    p.outcome_notes = null;
    if (file_data.latest && file_data.latest.session_id === session_id) file_data.latest = rec;
    save_file(file_data);
}

function start_trial_from_record(white_rabbit, record) {
    if (!white_rabbit.intelligence || white_rabbit.intelligence.active_trial) return;
    if (!record || !Array.isArray(record.perspectives)) return;

    const chosen = record.perspectives.find(p => !p.tried && p.parameters && Object.keys(p.parameters).length > 0);
    if (!chosen) return;

    const applied = apply_perspective_parameters(white_rabbit, chosen.parameters, chosen.description || 'perspective trial');
    if (!applied.length) return;

    mark_perspective_started(record.session_id, chosen.id);

    const now = Date.now();
    const timeout_ms = white_rabbit.intelligence.trial_timeout_ms || DEFAULT_TRIAL_TIMEOUT_MS;
    white_rabbit.intelligence.active_trial = {
        session_id: record.session_id,
        perspective_id: chosen.id,
        situation: record.situation,
        started_at: now,
        expires_at: now + timeout_ms,
        applied,
        clear_since_ts: null
    };

    safe_log(white_rabbit, 'trial started: ' + chosen.id + ' for ' + record.situation + ' (timeout=' + timeout_ms + 'ms)');
    say_intelligence_status(white_rabbit, 'Trying: ' + brief_perspective_text(chosen.description), false);
}

function trial_success_now(white_rabbit, trial) {
    const mission = white_rabbit.mission || {};
    const watchdog = mission.memory_watchdog || {};

    if (trial.situation === 'path_blocked') {
        return !mission.realsense_blocked_since && !mission.avoidance_timed_out;
    }
    if (trial.situation === 'stuck_detected') {
        return !watchdog.recovery_state && !mission.avoidance_timed_out;
    }
    if (trial.situation === 'avoidance_started') {
        return !mission.avoidance_timed_out;
    }
    if (trial.situation === 'mission_uncertainty') {
        const det = white_rabbit.realsense && white_rabbit.realsense.path_detection;
        return !!(det && typeof det.confidence === 'number' && det.confidence >= 0.55);
    }

    return false;
}

function finalize_active_trial(white_rabbit, success, notes) {
    if (!white_rabbit.intelligence || !white_rabbit.intelligence.active_trial) return;
    const trial = white_rabbit.intelligence.active_trial;

    if (!success) {
        rollback_trial_parameters(white_rabbit, trial.applied);
    }

    record_outcome(
        white_rabbit,
        trial.session_id,
        trial.perspective_id,
        !!success,
        notes || (success ? 'auto success' : 'auto timeout/rollback')
    );

    safe_log(white_rabbit, 'trial ' + (success ? 'success' : 'failure') + ': ' + trial.perspective_id + (notes ? ' (' + notes + ')' : ''));
    say_intelligence_status(white_rabbit, success ? 'Worked. Continuing.' : 'Timed out. Reverting.', false);
    white_rabbit.intelligence.active_trial = null;
}

function evaluate_active_trial(white_rabbit) {
    if (!white_rabbit.intelligence || !white_rabbit.intelligence.active_trial) return;
    const trial = white_rabbit.intelligence.active_trial;
    const now = Date.now();

    if (trial_success_now(white_rabbit, trial)) {
        if (!trial.clear_since_ts) trial.clear_since_ts = now;
        if (now - trial.clear_since_ts >= 5000) {
            finalize_active_trial(white_rabbit, true, 'condition cleared for >=5s');
        }
    } else {
        trial.clear_since_ts = null;
        if (now >= trial.expires_at) {
            finalize_active_trial(white_rabbit, false, 'trial timeout');
        }
    }
}

// ---- Main: consider(situation) ----
// Non-blocking. Generates local perspectives immediately, persists them, then
// fires an async Claude consultation if internet is available. Never delays the
// 250 ms mission loop.

function consider(white_rabbit, situation, extra_context) {
    if (!white_rabbit.intelligence || !white_rabbit.intelligence.enabled) return;

    situation = canonical_situation(situation);

    const now = Date.now();
    const cooldown = white_rabbit.intelligence.consult_cooldown_ms || 60000;
    if (now - white_rabbit.intelligence.last_consider_ts < cooldown) return;
    white_rabbit.intelligence.last_consider_ts = now;

    const ctx = Object.assign(build_context(white_rabbit, situation), extra_context || {});
    const generator = GENERATORS[situation];
    const local_perspectives = generator ? generator(white_rabbit, ctx) : [];

    // Inject a recent dream as a perspective if it matches this situation.
    // Dreams are Noah's imaginative angles — they enrich the perspective list
    // with views that rule-based generators would not produce on their own.
    if (white_rabbit.dreams && typeof white_rabbit.dreams.relevant_for === 'function') {
        const dream = white_rabbit.dreams.relevant_for(situation);
        if (dream) {
            local_perspectives.push({
                id:             generate_id(),
                description:    dream.perspective,
                parameters:     {},
                priority:       (dream.influence && typeof dream.influence.priority === 'number')
                                    ? dream.influence.priority : 0.50,
                priority_reason: 'From Noah\'s recent dream (' + dream.seed.trigger + '): ' + dream.vision.slice(0, 80) + '…',
            });
            safe_log(white_rabbit, 'dream perspective injected for ' + situation + ' (dreamed ' + dream.seed.trigger + ')');
        }
    }

    const file_data = load_file();
    if (!Array.isArray(file_data.history)) file_data.history = [];

    const record = {
        session_id:              String(now),
        generated_at:            new Date(now).toISOString(),
        situation,
        context_snapshot:        ctx,
        source:                  'local',
        perspectives:            enrich_and_rank_perspectives(file_data, situation, local_perspectives),
        parameter_edits_applied: [],
    };

    file_data.history.unshift(record);
    if (file_data.history.length > MAX_HISTORY) file_data.history = file_data.history.slice(0, MAX_HISTORY);
    file_data.latest = record;
    save_file(file_data);

    // Phase 1: run one bounded live trial from the top-ranked perspective.
    start_trial_from_record(white_rabbit, record);

    safe_log(white_rabbit, 'considering ' + situation + ' — ' + local_perspectives.length + ' local perspectives written to perspectives.json');

    const intel_cfg = white_rabbit.intelligence_config || {};
    if (intel_cfg.claude_enabled !== false && white_rabbit.claude_advisor) {
        setImmediate(async () => {
            try {
                const result = await white_rabbit.claude_advisor.consult(white_rabbit, situation, ctx, local_perspectives);
                if (!result) return;

                if (Array.isArray(result.perspectives) && result.perspectives.length > 0) {
                    record.source = 'claude';
                    const snapshot = load_file();
                    record.perspectives = enrich_and_rank_perspectives(snapshot, situation, result.perspectives);
                }

                if (intel_cfg.auto_apply_params !== false && Array.isArray(result.parameter_suggestions) && result.parameter_suggestions.length > 0) {
                    record.parameter_edits_applied = apply_parameter_suggestions(white_rabbit, result.parameter_suggestions);
                }

                const updated = load_file();
                if (!Array.isArray(updated.history)) updated.history = [];
                const idx = updated.history.findIndex(r => r.session_id === record.session_id);
                if (idx >= 0) updated.history[idx] = record;
                else updated.history.unshift(record);
                updated.latest = record;
                save_file(updated);

                safe_log(white_rabbit, 'claude enriched ' + situation + ' — ' + record.perspectives.length + ' perspectives' +
                    (record.parameter_edits_applied.length ? ', ' + record.parameter_edits_applied.length + ' params applied' : ''));
            } catch (err) {
                safe_log(white_rabbit, 'claude consult failed: ' + (err && err.message ? err.message : String(err)));
            }
        });
    }
}

function record_outcome(white_rabbit, session_id, perspective_id, success, notes) {
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

function get_best(white_rabbit) {
    const file_data = load_file();
    const latest = file_data.latest;
    if (!latest || !Array.isArray(latest.perspectives)) return null;
    return latest.perspectives
        .filter(p => !p.tried)
        .sort((a, b) => {
            const pa = (typeof a.priority_blended === 'number') ? a.priority_blended : (a.priority || 0);
            const pb = (typeof b.priority_blended === 'number') ? b.priority_blended : (b.priority || 0);
            return pb - pa;
        })[0] || null;
}

var white_rabbit_intelligence = function (white_rabbit) {
    const cfg = white_rabbit.intelligence_config || {};
    const enabled = cfg.enabled !== false;

    white_rabbit.intelligence = {
        enabled,
        last_consider_ts:    0,
        consult_cooldown_ms: typeof cfg.consult_cooldown_ms === 'number' ? cfg.consult_cooldown_ms : 60000,
        trial_timeout_ms:    typeof cfg.trial_timeout_ms === 'number' ? cfg.trial_timeout_ms : DEFAULT_TRIAL_TIMEOUT_MS,
        active_trial:        null,
        consider:            (situation, ctx) => consider(white_rabbit, situation, ctx),
        record_outcome:      (session_id, perspective_id, success, notes) => record_outcome(white_rabbit, session_id, perspective_id, success, notes),
        get_best:            () => get_best(white_rabbit),
    };

    if (!enabled) {
        safe_log(white_rabbit, 'disabled in setup.json');
        return;
    }

    if (cfg.claude_enabled !== false) {
        white_rabbit.claude_advisor = require('./claude_advisor.js');
        safe_log(white_rabbit, 'enabled — Claude online when internet available (auto_apply_params=' + (cfg.auto_apply_params !== false) + ')');
    } else {
        safe_log(white_rabbit, 'enabled — local perspectives only (claude_enabled: false in setup.json)');
    }

    // Evaluate active trials out-of-band so mission loop is never blocked.
    setInterval(() => {
        try { evaluate_active_trial(white_rabbit); } catch (_) {}
    }, 1000);
}

module.exports = white_rabbit_intelligence;
