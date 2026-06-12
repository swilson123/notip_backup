// RC Observer — the white_rabbit's apprenticeship.
//
// When a human is driving the white_rabbit (Manual / Acro / Steering flight modes),
// the white_rabbit pays attention. Every observation interval it records where it
// just went — a "human_demonstration" — building a ghost path of good
// driving it can consult later when running solo. When the human slows
// from speed to stop at a place, that becomes a "human_caution" — a hint
// that the location warranted care.
//
// The white_rabbit doesn't move from this module. It only watches and remembers.
// And as it watches, it becomes more beautiful: demonstrations lift speed
// confidence and steering steadiness; cautions soften the speed bias just
// a little, the way the human's hands did at the same spot.

const DEFAULT_OBSERVATION_INTERVAL_MS = 2000;   // record a demo at most every 2s
const CHECK_INTERVAL_MS                = 500;   // detect transitions promptly
const SLOWDOWN_SPEED_THRESHOLD         = 20;    // below this → slowing
const MOVEMENT_THRESHOLD_M             = 0.5;   // need to have moved this much to count as a demo

const HUMAN_FLIGHT_MODES = new Set(['Manual', 'Acro', 'Steering']);

function safe_log(white_rabbit, msg) {
    if (white_rabbit.logs && white_rabbit.logs.run_mission && typeof white_rabbit.logs.run_mission.log === 'function') {
        white_rabbit.logs.run_mission.log(white_rabbit, msg);
    } else {
        console.log(msg);
    }
}

function is_human_driving(white_rabbit) {
    if (!white_rabbit.robot_data || !white_rabbit.robot_data.is_armed) return false;
    const mode = white_rabbit.robot_data.robot_flight_mode;
    if (mode && HUMAN_FLIGHT_MODES.has(mode))                                                  return true;
    if (white_rabbit.flight_data && white_rabbit.flight_data.control_type === 'manual')                      return true;
    if (white_rabbit.flight_data && white_rabbit.flight_data.manual_intervention)                            return true;
    return false;
}

var rc_observer = function (white_rabbit) {
    const cfg = white_rabbit.rc_observer_config || {};
    const enabled = cfg.enabled !== false;
    const observation_interval_ms = (typeof cfg.observation_interval_ms === 'number')
        ? cfg.observation_interval_ms : DEFAULT_OBSERVATION_INTERVAL_MS;

    const obs = {
        enabled:                 enabled,
        observation_interval_ms: observation_interval_ms,
        active:                  false,
        observations:            0,
        cautions:                0,
        session_start_ts:        0,
        last_observation_ts:     0,
        last_observation_lat:    null,
        last_observation_lng:    null,
        last_speed_cmd:          0,
        interval:                null,

        stop() { if (this.interval) { clearInterval(this.interval); this.interval = null; } }
    };

    white_rabbit.rc_observer = obs;

    if (!enabled) {
        safe_log(white_rabbit, 'rc_observer: disabled in setup.json');
        return;
    }

    obs.interval = setInterval(() => {
        try {
            const human = is_human_driving(white_rabbit);

            // Transition: human stopped driving (or white_rabbit disarmed)
            if (obs.active && !human) {
                const duration_s = (Date.now() - obs.session_start_ts) / 1000;
                safe_log(white_rabbit, 'rc_observer: session ended — '
                    + obs.observations + ' demonstrations, '
                    + obs.cautions + ' cautions over '
                    + duration_s.toFixed(0) + 's');
                obs.active             = false;
                obs.observations       = 0;
                obs.cautions           = 0;
                obs.last_observation_lat = null;
                obs.last_observation_lng = null;
                obs.last_speed_cmd     = 0;
                return;
            }

            // Transition: human just started driving
            if (!obs.active && human) {
                obs.active               = true;
                obs.session_start_ts     = Date.now();
                obs.last_observation_ts  = 0;
                obs.last_observation_lat = null;
                obs.last_observation_lng = null;
                obs.last_speed_cmd       = 0;
                safe_log(white_rabbit, 'rc_observer: human is driving — paying attention');
                return;
            }

            // Active observation
            if (!obs.active) return;
            if (Date.now() - obs.last_observation_ts < obs.observation_interval_ms) return;

            const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
            const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
            if (typeof lat !== 'number' || typeof lng !== 'number') return;

            const speed_cmd = (white_rabbit.motor && white_rabbit.motor.motor_speed_cmd) || 0;
            const heading   = white_rabbit.get_heading ? white_rabbit.get_heading(white_rabbit)
                : (white_rabbit.imu_data && white_rabbit.imu_data.heading);

            // First observation — just seed the state, nothing to compare yet.
            if (obs.last_observation_lat === null) {
                obs.last_observation_ts   = Date.now();
                obs.last_observation_lat  = lat;
                obs.last_observation_lng  = lng;
                obs.last_speed_cmd        = speed_cmd;
                return;
            }

            const moved_m = (typeof white_rabbit.gps_distance === 'function')
                ? white_rabbit.gps_distance(obs.last_observation_lat, obs.last_observation_lng, lat, lng) * 1000
                : 0;

            // Caution: the human transitioned from driving (speed above the
            // threshold) to stopped (speed at or below it). The movement
            // since the last observation doesn't matter — what matters is
            // the human's choice to slow at this location. Once recorded,
            // last_speed_cmd updates to the current value, so the same
            // slowdown only fires the event once.
            const just_slowed = obs.last_speed_cmd > SLOWDOWN_SPEED_THRESHOLD
                             && speed_cmd <= SLOWDOWN_SPEED_THRESHOLD;

            if (just_slowed && white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
                white_rabbit.learning.add('human_caution', { lat: lat, lng: lng, prior_speed_cmd: obs.last_speed_cmd });
                obs.cautions++;
            } else if (moved_m >= MOVEMENT_THRESHOLD_M && white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
                white_rabbit.learning.add('human_demonstration', {
                    lat:       lat,
                    lng:       lng,
                    speed_cmd: speed_cmd,
                    heading:   heading
                });
                obs.observations++;
            }

            obs.last_observation_ts  = Date.now();
            obs.last_observation_lat = lat;
            obs.last_observation_lng = lng;
            obs.last_speed_cmd       = speed_cmd;
        } catch (_) {
            // Apprenticeship must never crash the white_rabbit.
        }
    }, CHECK_INTERVAL_MS);

    safe_log(white_rabbit, 'rc_observer: watching for human driving (observation interval ' + observation_interval_ms + 'ms)');
}

module.exports = rc_observer;
