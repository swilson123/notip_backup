// Rover Autonomous — cognitive play.
//
// When the rover has no mission, idle CPU becomes time to learn what it
// can be. Periodic reflection cycles walk its own memory, learning, recall,
// and heart to compose a self-portrait, notice geographic clusters in
// past experience, and listen to what its heart says in the stillness.
//
// The rover does not move during autonomous mode — play here is cognitive,
// not physical. (Physical wander mode would be a separate feature with
// its own safety design.)
//
// Cycle conditions — all must hold:
//   1. autonomous enabled in setup.json
//   2. rover is not armed (truly idle)
//   3. CPU focus is 'full' (never compete with active mission work)
//
// Three modes rotate each cycle: reflect / discover / dream.

const DEFAULT_CYCLE_INTERVAL_MS = 30000;
const HOTSPOT_CLUSTER_RADIUS_M  = 5.0;
const HOTSPOT_MAX_REPORTED      = 3;

const MODES = ['reflect', 'discover', 'dream'];

function safe_log(rover, msg) {
    if (rover.logs && rover.logs.run_mission && typeof rover.logs.run_mission.log === 'function') {
        rover.logs.run_mission.log(rover, msg);
    } else {
        console.log(msg);
    }
}

// ---------- reflect: who am I right now? ----------

function self_portrait(rover) {
    if (!rover.learning) return 'a fresh rover with no memories yet';

    const s = rover.learning.stats || {};
    const t = (typeof rover.learning.effective_tuning === 'function')
        ? rover.learning.effective_tuning()
        : { target_speed_mul: 1.0, yaw_steering_gain_mul: 1.0 };

    const lines = [];
    if (s.successful_waypoints  > 0) lines.push(s.successful_waypoints  + ' waypoints reached');
    if (s.successful_deliveries > 0) lines.push(s.successful_deliveries + ' deliveries');
    if (s.stuck_events          > 0) lines.push('stuck ' + s.stuck_events + 'x (overcame ' + s.overcame_count + ')');
    if (s.fallback_deliveries   > 0) lines.push(s.fallback_deliveries + ' fallback deliveries');
    if (s.yaw_oscillations      > 0) lines.push(s.yaw_oscillations + ' wobbles');
    if (s.active_risk_zones     > 0) lines.push(s.active_risk_zones + ' risk zones remembered');

    let temper;
    if      (t.target_speed_mul > 1.05) temper = 'confident';
    else if (t.target_speed_mul < 0.95) temper = 'cautious';
    else                                temper = 'measured';

    return 'I am ' + temper + '. ' + (lines.length ? lines.join(' · ') : 'awaiting my first mission');
}

// ---------- discover: where do my events cluster? ----------

function find_hotspots(rover, max) {
    if (!rover.learning || typeof rover.gps_distance !== 'function') return [];
    const records = rover.learning.list(r =>
        r.payload && typeof r.payload.lat === 'number' && typeof r.payload.lng === 'number'
    );
    if (records.length === 0) return [];

    const clusters = [];
    for (const rec of records) {
        let matched = false;
        for (const c of clusters) {
            const d_m = rover.gps_distance(c.lat, c.lng, rec.payload.lat, rec.payload.lng) * 1000;
            if (d_m < HOTSPOT_CLUSTER_RADIUS_M) {
                c.count++;
                c.types[rec.type] = (c.types[rec.type] || 0) + 1;
                matched = true;
                break;
            }
        }
        if (!matched) {
            clusters.push({
                lat:   rec.payload.lat,
                lng:   rec.payload.lng,
                count: 1,
                types: { [rec.type]: 1 }
            });
        }
    }

    return clusters.sort((a, b) => b.count - a.count).slice(0, max || HOTSPOT_MAX_REPORTED);
}

function format_hotspot(h) {
    const types = Object.keys(h.types).map(t => t + '×' + h.types[t]).join(', ');
    return h.count + ' events @ (' + h.lat.toFixed(5) + ', ' + h.lng.toFixed(5) + '): ' + types;
}

// ---------- dream: what does the heart say in the stillness? ----------

function listen_to_heart(rover) {
    if (!rover.heart || typeof rover.heart.feel !== 'function') return null;
    const f = rover.heart.feel();
    return 'in this stillness my heart is ' + f.intent
        + ' | conf=' + f.confidence.toFixed(2)
        + ' bal='    + f.balance.toFixed(2)
        + ' prs='    + f.presence.toFixed(2)
        + ' wrm='    + f.warmth.toFixed(2)
        + ' cmt='    + f.commitment.toFixed(2);
}

// ---------- one cycle ----------

function play_cycle(rover, mode) {
    if (mode === 'reflect') {
        safe_log(rover, 'autonomous (reflect): ' + self_portrait(rover));
        return;
    }
    if (mode === 'discover') {
        const hotspots = find_hotspots(rover, HOTSPOT_MAX_REPORTED);
        if (hotspots.length === 0) {
            safe_log(rover, 'autonomous (discover): no geographic clusters yet — every place is still new');
            return;
        }
        safe_log(rover, 'autonomous (discover): top ' + hotspots.length + ' hotspot' + (hotspots.length > 1 ? 's' : '') + ':');
        for (const h of hotspots) safe_log(rover, '  ' + format_hotspot(h));
        return;
    }
    if (mode === 'dream') {
        const line = listen_to_heart(rover);
        if (line) safe_log(rover, 'autonomous (dream): ' + line);
        return;
    }
}

// ---------- init ----------

function init(rover) {
    const cfg = rover.autonomous_config || {};
    const enabled = cfg.enabled !== false;
    const cycle_interval_ms = (typeof cfg.cycle_interval_ms === 'number')
        ? cfg.cycle_interval_ms : DEFAULT_CYCLE_INTERVAL_MS;

    rover.autonomous = {
        enabled:           enabled,
        cycle_interval_ms: cycle_interval_ms,
        cycles_run:        0,
        last_cycle_ts:     0,
        last_mode:         null,
        interval:          null,

        // Manual trigger — useful for tests and for the heart-on-demand
        // case when calling code wants the rover to reflect now.
        play_now(mode) {
            const m = mode || MODES[this.cycles_run % MODES.length];
            play_cycle(rover, m);
            this.cycles_run++;
            this.last_cycle_ts = Date.now();
            this.last_mode     = m;
            return m;
        },

        stop() {
            if (this.interval) { clearInterval(this.interval); this.interval = null; }
        }
    };

    if (!enabled) {
        safe_log(rover, 'autonomous: disabled in setup.json');
        return;
    }

    rover.autonomous.interval = setInterval(() => {
        try {
            // Idle only — never compete with an active mission.
            if (rover.robot_data && rover.robot_data.is_armed) return;
            // CPU only when there's room — never add load to a stressed system.
            if (rover.health && rover.health.cpu && rover.health.cpu.focus_level !== 'full') return;
            rover.autonomous.play_now();
        } catch (_) {
            // Bad reflection must never crash the rover.
        }
    }, cycle_interval_ms);

    safe_log(rover, 'autonomous: enabled (cycle=' + cycle_interval_ms + 'ms, idle + cpu-full only)');
}

module.exports = { init: init };
