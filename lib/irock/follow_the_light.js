// Follow the Light — IRLock beacon-guided ramp docking.
//
// When Noah returns to the undock position (recorded lat/lng/heading at the
// start of the mission), it hands off from GPS navigation to this module.
// The IRLock beacon at the dock becomes the truth — Noah follows the light.
//
// State machine:
//
//   seek       → Beacon not yet visible.  Rover holds still and makes small
//                yaw sweeps to acquire the beacon.  Transitions to 'approach'
//                once a fresh IRLock target is seen.
//
//   approach   → Beacon visible, rover on flat ground.  Steer toward the
//                beacon using angle_x for horizontal alignment; drive at base
//                speed.  Transitions to 'ramp' when pitch departs by
//                ramp_detect_pitch_delta.
//
//   ramp       → Rover is climbing the ramp.  IRLock beacon is no longer used
//                — physical rails on the ramp handle horizontal positioning.
//                Pitch compensation increases motor speed to maintain momentum.
//                Roll compensation adjusts left/right balance.  Beacon loss is
//                ignored.  Transitions to 'complete' after 3 s when pitch
//                returns near ground level (rover has crested onto dock).
//
//   complete   → Top of ramp reached, drive for post_ramp_drive_ms more
//                milliseconds then stop.  Signals done via dock_state.
//
// Motor direction: same convention as dock_rover.js (backing up the ramp).
// Motors 1,2 at +speed → rover moves toward dock.
// Motors 3,4 at -speed → same.
// To steer RIGHT while backing: increase left (1,2), decrease right (abs 3,4).
// Set irlock.steer_invert = true in setup.json if corrections feel backwards.
//
// Pitch and roll are read from rover.imu_data (BNO055).

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

var follow_the_light = function (rover) {
    if (!rover.robot_data.is_armed) {
        console.log('follow_the_light: rover is disarmed');
        return;
    }
    if (!rover.imu_data.connected) {
        console.log('follow_the_light: waiting for IMU');
        return;
    }

    const cfg = rover.irlock.follow_config;

    const base_speed          = cfg.base_speed          || 22;
    const ramp_detect_delta   = cfg.ramp_detect_delta   || 0.12;   // rad ~6.9°
    const level_tolerance     = cfg.level_tolerance     || 0.07;   // rad ~4.0°
    const post_ramp_drive_ms  = cfg.post_ramp_drive_ms  || 2500;
    const steer_gain          = cfg.steer_gain          || 1.2;    // RPM per deg of angle_x error
    const steer_invert        = cfg.steer_invert        || false;  // flip if corrections go wrong way
    const pitch_gain          = cfg.pitch_gain          || 30;     // extra RPM per radian of pitch
    const roll_gain           = cfg.roll_gain           || 20;     // RPM diff per radian of roll
    const max_steer_rpm       = cfg.max_steer_rpm       || 15;     // max correction added each side
    const seek_yaw_speed      = cfg.seek_yaw_speed      || 12;     // RPM for seek sweeps
    const seek_sweep_ms       = cfg.seek_sweep_ms       || 800;    // ms per seek sweep direction
    const size_stop_threshold = cfg.size_stop_threshold || 0.35;   // beacon fill % → too close, stop

    const dock  = rover.dock;
    const state = dock.follow_state;

    // ── helpers ──────────────────────────────────────────────────────────────

    function drive(speed, steer_delta_left, label) {
        // Positive steer_delta_left means left side faster → turns right
        const left_rpm  = clamp(speed + steer_delta_left,  0, 60);
        const right_rpm = clamp(speed - steer_delta_left,  0, 60);
        rover.move_rover(rover, 1,  left_rpm, label);
        rover.move_rover(rover, 2,  left_rpm, label);
        rover.move_rover(rover, 3, -right_rpm, label);
        rover.move_rover(rover, 4, -right_rpm, label);
    }

    function stop_all(label) {
        rover.move_rover(rover, 1, 0, label);
        rover.move_rover(rover, 2, 0, label);
        rover.move_rover(rover, 3, 0, label);
        rover.move_rover(rover, 4, 0, label);
    }

    // Compute steering delta from beacon angle_x.
    // angle_x > 0 → beacon right → steer right → left motors faster.
    function steer_delta_from_beacon() {
        const t = rover.irlock.target;
        if (!t) return 0;
        const raw   = t.angle_x * steer_gain;
        const sign  = steer_invert ? -1 : 1;
        return clamp(raw * sign, -max_steer_rpm, max_steer_rpm);
    }

    // Speed boost from pitch: more pitch = climbing steeper = more power needed.
    function pitch_speed_boost() {
        const pitch_rad = (rover.imu_data.pitch || 0) * (Math.PI / 180);
        return clamp(Math.abs(pitch_rad) * pitch_gain, 0, 20);
    }

    // Roll correction: tilting right (positive roll) → right side lower → add power left.
    function roll_steer_correction() {
        const roll_rad = (rover.imu_data.roll || 0) * (Math.PI / 180);
        return clamp(roll_rad * roll_gain, -max_steer_rpm, max_steer_rpm);
    }

    // ── state machine ────────────────────────────────────────────────────────

    if (!state.phase) {
        state.phase             = 'seek';
        state.ref_pitch         = rover.imu_data.pitch || 0;
        state.ramp_entered_at   = null;
        state.seek_direction    = 1;
        state.seek_switched_at  = Date.now();
        state.complete_timer    = null;
        rover.logs.irlock.log(rover, 'follow_the_light: starting — ref_pitch=' + state.ref_pitch.toFixed(2));
        if (rover.voice) rover.voice.say_event('docking');
    }

    // ── seek ─────────────────────────────────────────────────────────────────
    if (state.phase === 'seek') {
        const fresh = rover.irlock_message_handler.is_fresh(rover);
        if (fresh && rover.irlock.target) {
            state.phase = 'approach';
            stop_all('follow_the_light seek→approach');
            rover.logs.irlock.log(rover, 'follow_the_light: beacon acquired → approach');
            if (rover.voice) rover.voice.say('Light acquired. Approaching the dock.');
            return;
        }

        // No beacon yet — slow yaw sweep to scan for it
        const now = Date.now();
        if (now - state.seek_switched_at > seek_sweep_ms) {
            state.seek_direction  *= -1;
            state.seek_switched_at = now;
        }
        // Yaw in place: one side forward, other back
        const sr = seek_yaw_speed * state.seek_direction;
        rover.move_rover(rover, 1,  sr, 'follow_the_light seek');
        rover.move_rover(rover, 2,  sr, 'follow_the_light seek');
        rover.move_rover(rover, 3,  sr, 'follow_the_light seek');
        rover.move_rover(rover, 4,  sr, 'follow_the_light seek');
        return;
    }

    // ── approach ─────────────────────────────────────────────────────────────
    // IRLock beacon used for horizontal positioning only. Once on the ramp the
    // beacon will be out of view; physical rails guide the rover from that point.
    if (state.phase === 'approach' || state.phase === 'ramp') {
        const fresh = rover.irlock_message_handler.is_fresh(rover);

        if (!fresh) {
            if (state.phase === 'approach') {
                // Lost beacon before reaching the ramp — go back to seek.
                stop_all('follow_the_light beacon lost');
                state.phase = 'seek';
                state.seek_switched_at = Date.now();
                rover.logs.irlock.log(rover, 'follow_the_light: beacon lost → seek');
                if (rover.voice) rover.voice.say('Light lost. Searching.');
                return;
            }
            // On the ramp beacon loss is expected — rails handle horizontal position.
        }

        // Size-stop check only applies during approach (beacon too close before ramp).
        if (state.phase === 'approach'
                && rover.irlock.target && rover.irlock.target.size_norm >= size_stop_threshold) {
            stop_all('follow_the_light size stop');
            state.phase = 'complete';
            rover.logs.irlock.log(rover, 'follow_the_light: beacon fill threshold → complete');
            return;
        }

        const pitch       = rover.imu_data.pitch || 0;
        const pitch_delta = pitch - state.ref_pitch;

        // Detect ramp entry.
        if (state.phase === 'approach' && Math.abs(pitch_delta) >= ramp_detect_delta) {
            state.phase           = 'ramp';
            state.ramp_entered_at = Date.now();
            rover.logs.irlock.log(rover, 'follow_the_light: ramp detected (pitch_delta=' + pitch_delta.toFixed(3) + ')');
            if (rover.voice) rover.voice.say('Climbing the ramp.');
        }

        // Detect ramp exit: after 3 s on the ramp, stop when pitch returns near
        // ground level — the rover has crested onto the dock platform.
        if (state.phase === 'ramp') {
            const on_ramp_long_enough = state.ramp_entered_at && (Date.now() - state.ramp_entered_at > 3000);
            if (on_ramp_long_enough && Math.abs(pitch_delta) <= level_tolerance) {
                stop_all('follow_the_light ramp→complete');
                state.phase = 'complete';
                rover.logs.irlock.log(rover, 'follow_the_light: top of ramp → complete');
                if (rover.voice) rover.voice.say('Top of the ramp. Almost home.');
                return;
            }
        }

        // Approach: steer toward beacon for horizontal alignment.
        // Ramp: drive straight — rails do the work, no beacon steering.
        const boost = (state.phase === 'ramp') ? pitch_speed_boost() : 0;
        const speed = base_speed + boost;
        const steer = (state.phase === 'approach')
            ? steer_delta_from_beacon() + roll_steer_correction()
            : roll_steer_correction();

        drive(speed, steer, 'follow_the_light ' + state.phase);

        // Log at 1 Hz
        const now = Date.now();
        if (!state._last_log_ts || now - state._last_log_ts >= 1000) {
            state._last_log_ts = now;
            const t = rover.irlock.target;
            rover.logs.irlock.log(rover,
                'follow_the_light ' + state.phase
                + ' | angle_x=' + (t && state.phase === 'approach' ? t.angle_x.toFixed(1) : '--') + '°'
                + ' pitch=' + pitch.toFixed(1) + '° (Δ=' + pitch_delta.toFixed(2) + ')'
                + ' roll=' + (rover.imu_data.roll || 0).toFixed(1) + '°'
                + ' speed=' + speed.toFixed(0)
                + ' steer=' + steer.toFixed(1)
            );
        }
        return;
    }

    // ── complete ─────────────────────────────────────────────────────────────
    if (state.phase === 'complete') {
        if (!state.complete_timer) {
            rover.logs.irlock.log(rover, 'follow_the_light: docked — driving post-ramp ' + post_ramp_drive_ms + 'ms');
            // Continue forward for a short time to fully seat in dock
            drive(base_speed * 0.7, 0, 'follow_the_light complete');
            state.complete_timer = setTimeout(() => {
                stop_all('follow_the_light done');

                // Record final dock pose into the God variable
                dock.dock_latitude  = rover.robot_data.robot_latitude;
                dock.dock_longitude = rover.robot_data.robot_longitude;
                dock.dock_pitch     = rover.imu_data.pitch || 0;
                dock.dock_heading   = rover.get_heading(rover);

                // Signal dock_rover.js that IRLock docking is done
                dock.dock_state = 'docked_completed';

                if (dock.dock_interval) {
                    clearInterval(dock.dock_interval);
                    dock.dock_interval = null;
                }

                state.complete_timer = null;
                rover.logs.irlock.log(rover,
                    'follow_the_light: complete. dock_lat=' + dock.dock_latitude
                    + ' dock_lng=' + dock.dock_longitude
                    + ' heading=' + dock.dock_heading.toFixed(1)
                );
                if (rover.voice) rover.voice.say_event('docking->standby');
            }, post_ramp_drive_ms);
        }
    }
};

module.exports = follow_the_light;
