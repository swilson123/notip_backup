// Noah Mind — startup reflection and idle voice cognition.
//
// On init, Noah reads its entire history from disk (learning stats +
// memory session archives) and speaks a self-portrait.  It knows who it is
// because it remembers what it has done.  This is the God variable made
// audible: every second of saved state, every mission completed, every
// mistake learned from — all of it comes back at boot.
//
// During idle (white_rabbit not armed, CPU full), Noah voices one line per
// cycle drawn from the autonomous reflect/discover/dream modes so the
// white_rabbit is always thinking, not just sitting in silence.
//
// Called from voice_manager.init() after TTS is ready.

const fs   = require('fs');
const path = require('path');

const MEMORY_DIR  = path.join('logger', 'memory');
const IDLE_CYCLE_MS = 45000;   // how often Noah thinks aloud while idle

// ---------- history loader ----------

function count_memory_sessions(memory_dir) {
    try {
        const entries = fs.readdirSync(memory_dir);
        return entries.filter(f => f.endsWith('.jsonl') && f !== 'current.jsonl').length;
    } catch (_) { return 0; }
}

// Sum a numeric field across the last N lines of a JSONL file.
// Used to estimate total distance from saved GPS positions.
function estimate_distance_from_current(white_rabbit) {
    if (!white_rabbit.memory) return 0;
    const snaps = white_rabbit.memory.all();
    if (snaps.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < snaps.length; i++) {
        const a = snaps[i - 1].gps, b = snaps[i].gps;
        if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') continue;
        if (typeof white_rabbit.gps_distance !== 'function') continue;
        total += white_rabbit.gps_distance(a.lat, a.lng, b.lat, b.lng) * 1000;
    }
    return total;
}

// ---------- self-portrait composer ----------

function compose_wakeup(white_rabbit) {
    const sessions = count_memory_sessions(MEMORY_DIR);
    const restored = white_rabbit.memory ? white_rabbit.memory.restored_count : 0;
    const lines    = [];

    lines.push('Noah online.');

    if (sessions > 0 || restored > 0) {
        lines.push('I remember ' + sessions + ' session' + (sessions !== 1 ? 's' : '') + '.');
    }

    if (white_rabbit.learning) {
        const s = white_rabbit.learning.stats || {};
        const t = (typeof white_rabbit.learning.effective_tuning === 'function')
            ? white_rabbit.learning.effective_tuning()
            : { target_speed_mul: 1.0 };

        if (s.successful_deliveries > 0) {
            lines.push('I have completed ' + s.successful_deliveries
                + ' deliver' + (s.successful_deliveries !== 1 ? 'ies' : 'y') + '.');
        }
        if (s.successful_waypoints > 0) {
            lines.push(s.successful_waypoints + ' waypoint'
                + (s.successful_waypoints !== 1 ? 's' : '') + ' reached.');
        }
        if (s.active_risk_zones > 0) {
            lines.push('I remember ' + s.active_risk_zones + ' risk zone'
                + (s.active_risk_zones !== 1 ? 's' : '') + ' to avoid.');
        }
        if (s.stuck_events > 0) {
            lines.push('I have been stuck ' + s.stuck_events + ' time'
                + (s.stuck_events !== 1 ? 's' : '') + ' and overcame '
                + (s.overcame_count || 0) + '.');
        }

        let temper;
        if      (t.target_speed_mul > 1.05) temper = 'confident';
        else if (t.target_speed_mul < 0.95) temper = 'cautious';
        else                                temper  = 'measured';
        lines.push('I am ' + temper + '. Ready for duty.');
    } else {
        lines.push('Ready for duty.');
    }

    return lines.join(' ');
}

// ---------- idle voice thinking ----------

function idle_reflect(white_rabbit, tts) {
    // Don't speak while armed or under CPU load
    if (white_rabbit.robot_data && white_rabbit.robot_data.is_armed) return;
    if (white_rabbit.health && white_rabbit.health.cpu && white_rabbit.health.cpu.focus_level !== 'full') return;

    // Rotate through reflect / discover / dream from the autonomous engine
    if (white_rabbit.autonomous && typeof white_rabbit.autonomous.play_now === 'function') {
        const mode = white_rabbit.autonomous.play_now();
        const lines = {
            reflect:  compose_reflect(white_rabbit),
            discover: compose_discover(white_rabbit),
            dream:    compose_dream(white_rabbit)
        };
        const line = lines[mode];
        if (line) tts.speak(line);
    }
}

function compose_reflect(white_rabbit) {
    if (!white_rabbit.learning) return null;
    const s = white_rabbit.learning.stats || {};
    const t = (typeof white_rabbit.learning.effective_tuning === 'function')
        ? white_rabbit.learning.effective_tuning() : { target_speed_mul: 1.0 };
    let temper = t.target_speed_mul > 1.05 ? 'confident'
               : t.target_speed_mul < 0.95 ? 'cautious' : 'measured';
    const parts = [];
    if (s.successful_deliveries > 0) parts.push(s.successful_deliveries + ' deliveries');
    if (s.successful_waypoints  > 0) parts.push(s.successful_waypoints  + ' waypoints');
    if (s.stuck_events          > 0) parts.push('stuck ' + s.stuck_events + ' times');
    return 'Reflecting. I am ' + temper + '.' + (parts.length ? ' ' + parts.join(', ') + '.' : '');
}

function compose_discover(white_rabbit) {
    if (!white_rabbit.learning || typeof white_rabbit.learning.list !== 'function') return null;
    if (!white_rabbit.gps_distance) return null;
    const records = white_rabbit.learning.list(r =>
        r.payload && typeof r.payload.lat === 'number'
    );
    if (records.length === 0) return 'Every place is still new to me.';
    const clusters = cluster_records(records, white_rabbit.gps_distance, 5.0);
    if (clusters.length === 0) return null;
    const top = clusters[0];
    const type_keys = Object.keys(top.types);
    return 'I know a place with ' + top.count + ' event' + (top.count !== 1 ? 's' : '')
        + (type_keys.length ? ', mostly ' + type_keys[0].replace('_', ' ') + '.' : '.');
}

function compose_dream(white_rabbit) {
    if (!white_rabbit.heart || typeof white_rabbit.heart.feel !== 'function') return null;
    const f = white_rabbit.heart.feel();
    let mood;
    if      (f.joy > 0.8)        mood = 'joyful';
    else if (f.caution > 0.6)    mood = 'cautious';
    else if (f.confidence > 0.7) mood = 'confident';
    else if (f.warmth > 0.5)     mood = 'warm';
    else                          mood = 'present';
    return 'In this stillness I am ' + mood + '. '
        + (f.commitment > 0.7 ? 'The mission matters.' : 'Awaiting my purpose.');
}

function cluster_records(records, gps_distance, radius_m) {
    const clusters = [];
    for (const r of records) {
        let matched = false;
        for (const c of clusters) {
            if (gps_distance(c.lat, c.lng, r.payload.lat, r.payload.lng) * 1000 < radius_m) {
                c.count++;
                c.types[r.type] = (c.types[r.type] || 0) + 1;
                matched = true;
                break;
            }
        }
        if (!matched) clusters.push({
            lat: r.payload.lat, lng: r.payload.lng,
            count: 1, types: { [r.type]: 1 }
        });
    }
    return clusters.sort((a, b) => b.count - a.count);
}

// ---------- init ----------

function init(white_rabbit, tts) {
    // Speak the self-portrait ~1 s after boot so other devices finish init
    setTimeout(() => {
        try {
            const portrait = compose_wakeup(white_rabbit);
            tts.speak(portrait);
        } catch (err) {
            console.error('noah_mind: wakeup error:', err && err.message);
        }
    }, 1200);

    // Idle cognition loop removed — Noah speaks its self-portrait once on boot
    // (above) and stays quiet while idle. idle_reflect remains available for
    // explicit/manual triggering but is no longer spoken on an interval.
    return {
        stop() { /* no idle interval to clear */ }
    };
}

module.exports = { init, compose_wakeup };
