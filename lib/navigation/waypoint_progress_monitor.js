'use strict';
// Waypoint progress monitor.
//
// Watches whether Noah is getting CLOSER to the active waypoint or FARTHER from it
// while driving toward it. Getting farther while commanded forward means the heading
// reference is wrong (the bearing error is being computed against a bad heading), so
// Noah drives off at an angle and never arrives. When that happens, the monitor learns
// a heading correction from the actual GPS course-over-ground and feeds it back into
// the steering heading so Noah turns the right way.
//
// It only fires on an UNAMBIGUOUS fault: a heading error has to exceed ~90° before the
// straight-line distance to the waypoint actually grows, so normal steering wobble
// (small errors still close distance) never triggers it. The correction is isolated to
// mission steering (white_rabbit.mission.heading_correction_deg) — it does not touch the
// compass/Pixhawk offsets or the displayed heading.

// Recompute progress/course every this much travel — long enough for a trustworthy
// GPS course-over-ground (above typical 1–3 m position noise).
var SAMPLE_DIST_M       = 3.0;
// Net increase in distance-to-waypoint over the window that counts as "moving away".
// At 3 m of travel this only happens for a heading error > ~90°.
var AWAY_TRIGGER_M      = 1.0;
// Clamp each correction step so one noisy sample can't spin Noah; a full reversal
// converges in ~2 windows.
var MAX_CORRECTION_STEP = 90;
// Throttle the spoken alert.
var VOICE_THROTTLE_MS   = 8000;

function signed_diff(a, b) { return ((a - b + 540) % 360) - 180; }

// Reset baseline + learned correction (call at mission start).
function reset(white_rabbit) {
    if (!white_rabbit.mission) return;
    white_rabbit.mission.heading_correction_deg = 0;
    white_rabbit.mission.progress_monitor = { ref_lat: null, ref_lng: null, ref_dist: null, last_voice_ts: 0 };
}

// dist_to_waypoint_m : current straight-line distance to the active waypoint (m)
// nav_heading_deg    : the heading actually used for steering this tick (correction already applied)
// Returns the current heading_correction_deg.
var waypoint_progress_monitor = function (white_rabbit, dist_to_waypoint_m, nav_heading_deg) {
    var m = white_rabbit.mission;
    if (!m) return 0;

    // Config gate (default ON).
    var nt = white_rabbit.nav_tuning || {};
    if (nt.nav_progress_monitor_enabled === false) return m.heading_correction_deg || 0;

    if (typeof m.heading_correction_deg !== 'number') m.heading_correction_deg = 0;
    if (!m.progress_monitor) m.progress_monitor = { ref_lat: null, ref_lng: null, ref_dist: null, last_voice_ts: 0 };
    var pm = m.progress_monitor;

    var lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    var lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    var cmd = white_rabbit.motor && white_rabbit.motor.motor_speed_cmd;
    var driving_forward = typeof cmd === 'number' && cmd > 0;
    var yaw_active = m.nav_control && m.nav_control.mission_yaw_active;

    // Only meaningful while driving straight forward toward a waypoint. Anything else
    // (turning in place, stopped, reversing, no fix) resets the baseline so a fresh
    // straight leg measures cleanly.
    if (!driving_forward || yaw_active || !lat || !lng || typeof dist_to_waypoint_m !== 'number') {
        pm.ref_lat = lat || null;
        pm.ref_lng = lng || null;
        pm.ref_dist = (typeof dist_to_waypoint_m === 'number') ? dist_to_waypoint_m : null;
        return m.heading_correction_deg;
    }

    if (pm.ref_lat === null || pm.ref_dist === null) {
        pm.ref_lat = lat; pm.ref_lng = lng; pm.ref_dist = dist_to_waypoint_m;
        return m.heading_correction_deg;
    }

    var traveled_m = white_rabbit.gps_distance(pm.ref_lat, pm.ref_lng, lat, lng) * 1000;
    if (traveled_m < SAMPLE_DIST_M) return m.heading_correction_deg; // wait for a full window

    var delta_dist = dist_to_waypoint_m - pm.ref_dist; // + = moved away, - = got closer

    if (delta_dist >= AWAY_TRIGGER_M) {
        // Moving away while driving forward → heading reference is wrong. The direction
        // we ACTUALLY traveled is the true heading; the gap to the heading we steered by
        // is the error to fold into the correction.
        var gps_course = white_rabbit.get_bearing(pm.ref_lat, pm.ref_lng, lat, lng);
        var err  = signed_diff(gps_course, nav_heading_deg);
        var step = Math.max(-MAX_CORRECTION_STEP, Math.min(MAX_CORRECTION_STEP, err));
        m.heading_correction_deg = signed_diff((m.heading_correction_deg + step + 360) % 360, 0);

        var msg = 'progress_monitor: moving AWAY (' + delta_dist.toFixed(1) + ' m over '
            + traveled_m.toFixed(1) + ' m) — gps_course=' + gps_course.toFixed(0)
            + '° nav_hdg=' + nav_heading_deg.toFixed(0) + '° → heading_correction='
            + m.heading_correction_deg.toFixed(0) + '°';
        if (white_rabbit.logs && white_rabbit.logs.run_mission) white_rabbit.logs.run_mission.log(white_rabbit, msg);
        else console.log(msg);

        var now = Date.now();
        if (white_rabbit.voice && (now - (pm.last_voice_ts || 0)) > VOICE_THROTTLE_MS) {
            pm.last_voice_ts = now;
            white_rabbit.voice.say('Wrong way. Correcting course.');
        }
    }

    // Start a fresh window from here regardless of outcome.
    pm.ref_lat = lat; pm.ref_lng = lng; pm.ref_dist = dist_to_waypoint_m;
    return m.heading_correction_deg;
};

waypoint_progress_monitor.reset = reset;

module.exports = waypoint_progress_monitor;
