// White_rabbit Autonomous — cognitive play.
//
// When the white_rabbit has no mission, idle CPU becomes time to learn what it
// can be. Periodic reflection cycles walk its own memory, learning, recall,
// and heart to compose a self-portrait, notice geographic clusters in
// past experience, and listen to what its heart says in the stillness.
//
// The white_rabbit does not move during autonomous mode — play here is cognitive,
// not physical. (Physical wander mode would be a separate feature with
// its own safety design.)
//
// Cycle conditions — all must hold:
//   1. autonomous enabled in setup.json
//   2. white_rabbit is not armed (truly idle)
//   3. CPU focus is 'full' (never compete with active mission work)
//
// Three modes rotate each cycle: reflect / discover / dream.

const DEFAULT_CYCLE_INTERVAL_MS = 30000;
const HOTSPOT_CLUSTER_RADIUS_M  = 5.0;
const HOTSPOT_MAX_REPORTED      = 3;

const MODES = ['reflect', 'discover', 'dream'];

function safe_log(white_rabbit, msg) {
    if (white_rabbit.logs && white_rabbit.logs.run_mission && typeof white_rabbit.logs.run_mission.log === 'function') {
        white_rabbit.logs.run_mission.log(white_rabbit, msg);
    } else {
        console.log(msg);
    }
}

// ---------- reflect: who am I right now? ----------

function self_portrait(white_rabbit) {
    if (!white_rabbit.learning) return 'a fresh white_rabbit with no memories yet';

    const s = white_rabbit.learning.stats || {};
    const t = (typeof white_rabbit.learning.effective_tuning === 'function')
        ? white_rabbit.learning.effective_tuning()
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

function find_hotspots(white_rabbit, max) {
    if (!white_rabbit.learning || typeof white_rabbit.gps_distance !== 'function') return [];
    const records = white_rabbit.learning.list(r =>
        r.payload && typeof r.payload.lat === 'number' && typeof r.payload.lng === 'number'
    );
    if (records.length === 0) return [];

    const clusters = [];
    for (const rec of records) {
        let matched = false;
        for (const c of clusters) {
            const d_m = white_rabbit.gps_distance(c.lat, c.lng, rec.payload.lat, rec.payload.lng) * 1000;
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

// ---------- dream: let the dream engine choose and generate ----------

function run_dream(white_rabbit) {
    if (white_rabbit.dreams && typeof white_rabbit.dreams.dream === 'function') {
        const d = white_rabbit.dreams.dream();
        if (!d) return;
        safe_log(white_rabbit, 'autonomous (dream): ' + d.vision);
        if (white_rabbit.voice && typeof white_rabbit.voice.say === 'function') {
            white_rabbit.voice.say(d.vision);
        }
        return;
    }
    // Fallback when dreams module is not loaded
    if (!white_rabbit.heart || typeof white_rabbit.heart.feel !== 'function') return;
    const f = white_rabbit.heart.feel();
    safe_log(white_rabbit, 'autonomous (dream): in this stillness my heart is ' + f.intent);
}

// ---------- one cycle ----------

function play_cycle(white_rabbit, mode) {
    if (mode === 'reflect') {
        safe_log(white_rabbit, 'autonomous (reflect): ' + self_portrait(white_rabbit));
        return;
    }
    if (mode === 'discover') {
        const hotspots = find_hotspots(white_rabbit, HOTSPOT_MAX_REPORTED);
        if (hotspots.length === 0) {
            safe_log(white_rabbit, 'autonomous (discover): no geographic clusters yet — every place is still new');
            return;
        }
        safe_log(white_rabbit, 'autonomous (discover): top ' + hotspots.length + ' hotspot' + (hotspots.length > 1 ? 's' : '') + ':');
        for (const h of hotspots) safe_log(white_rabbit, '  ' + format_hotspot(h));
        return;
    }
    if (mode === 'dream') {
        run_dream(white_rabbit);
        return;
    }
}

// ---------- init ----------

var white_rabbit_autonomous = function (white_rabbit) {
    const cfg = white_rabbit.autonomous_config || {};
    const enabled = cfg.enabled !== false;
    const cycle_interval_ms = (typeof cfg.cycle_interval_ms === 'number')
        ? cfg.cycle_interval_ms : DEFAULT_CYCLE_INTERVAL_MS;

    white_rabbit.autonomous = {
        enabled:           enabled,
        cycle_interval_ms: cycle_interval_ms,
        cycles_run:        0,
        last_cycle_ts:     0,
        last_mode:         null,
        interval:          null,

        // Manual trigger — useful for tests and for the heart-on-demand
        // case when calling code wants the white_rabbit to reflect now.
        play_now(mode) {
            const m = mode || MODES[this.cycles_run % MODES.length];
            play_cycle(white_rabbit, m);
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
        safe_log(white_rabbit, 'autonomous: disabled in setup.json');
        return;
    }

    white_rabbit.autonomous.interval = setInterval(() => {
        try {
            // Idle only — never compete with an active mission.
            if (white_rabbit.robot_data && white_rabbit.robot_data.is_armed) return;
            // CPU only when there's room — never add load to a stressed system.
            if (white_rabbit.health && white_rabbit.health.cpu && white_rabbit.health.cpu.focus_level !== 'full') return;
            white_rabbit.autonomous.play_now();
        } catch (_) {
            // Bad reflection must never crash the white_rabbit.
        }
    }, cycle_interval_ms);

    safe_log(white_rabbit, 'autonomous: enabled (cycle=' + cycle_interval_ms + 'ms, idle + cpu-full only)');
}

module.exports = white_rabbit_autonomous;
