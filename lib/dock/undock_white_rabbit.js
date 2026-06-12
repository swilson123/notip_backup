// Wheel-encoder odometry (same convention as voice_manager / compass_calibration):
// distance_m = avg(|Δpulses| over 4 wheels) / (cpr / (π · wheel_diameter_m)).
function odo_snapshot(white_rabbit) {
    var pos = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!pos) return null;
    return { 1: pos[1] | 0, 2: pos[2] | 0, 3: pos[3] | 0, 4: pos[4] | 0 };
}

function odo_distance_m(white_rabbit, start) {
    var pos = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!pos || !start) return null;
    var cfg = white_rabbit.voice_config || {};
    var wheel_diam_m = (typeof cfg.wheel_diameter_m   === 'number') ? cfg.wheel_diameter_m   : 0.254;
    var cpr          = (typeof cfg.cpr_pulses_per_rev === 'number') ? cfg.cpr_pulses_per_rev : 16385;
    var ppm = cpr / (Math.PI * wheel_diam_m);
    if (!(ppm > 0)) return null;
    var d = [1, 2, 3, 4].map(function (id) { return Math.abs((pos[id] | 0) - start[id]); });
    return ((d[0] + d[1] + d[2] + d[3]) / 4) / ppm;
}

var undock_white_rabbit = function (white_rabbit) {
    if (white_rabbit.robot_data.is_armed) {
        // Wait for a live Pixhawk ATTITUDE before reading pitch — dock_pitch is
        // captured once at undock start and a stale reading would break ramp
        // detection. Do NOT require the external IMU: it may be disabled
        // (imu.enabled=false), and get_pitch falls back to the Pixhawk ATTITUDE
        // anyway. typeof check so a perfectly level pitch of exactly 0 isn't
        // mistaken for "missing".
        if (!white_rabbit.robot_data.ATTITUDE || typeof white_rabbit.robot_data.ATTITUDE.pitch !== 'number') {
            console.log("Undock waiting for ATTITUDE message");
            return;
        }


        var motor_speed_cmd = 25;
        var ramp_detect_pitch_delta = 0.12; // ~6.9 deg
        var level_pitch_tolerance = 0.07;   // ~4.0 deg
        // Drive this far past the bottom of the ramp (wheel odometry) before fixing
        // the return point and raising the arm.
        var post_ramp_drive_m = (white_rabbit.nav_tuning && typeof white_rabbit.nav_tuning.post_ramp_drive_m === 'number')
            ? white_rabbit.nav_tuning.post_ramp_drive_m : 2.0;
        // Safety: finish the post-ramp leg on time even if encoder feedback is missing.
        var post_ramp_fallback_ms = 20000;
        // Pitch must stay level THIS long to call the ramp done — stops a single noisy
        // pitch sample mid-ramp from ending the ramp early (which raised the arm halfway down).
        var ramp_level_hold_ms = 1500;
        // If the white_rabbit never detects a ramp (parked on flat ground, missing
        // ramp, noisy pitch sensor), bail to "undocked" rather than driving
        // forward at speed 25 forever.
        var docked_state_timeout_ms = 5000;

        if (!white_rabbit.dock.dock_state) {
            console.log("Undocking White_rabbit");
            white_rabbit.dock.dock_state = "docked";
            white_rabbit.dock.docked_state_started_at = Date.now();

            // Record initial dock pose once at undock start.
            white_rabbit.dock.dock_latitude = white_rabbit.robot_data.robot_latitude;
            white_rabbit.dock.dock_longitude = white_rabbit.robot_data.robot_longitude;
            white_rabbit.dock.dock_pitch = white_rabbit.get_pitch(white_rabbit);
            white_rabbit.dock.dock_heading = white_rabbit.get_heading(white_rabbit);

            white_rabbit.dock.ramp_started_at = null;
            white_rabbit.dock.ramp_level_since = null;         // ramp-complete debounce
            white_rabbit.dock.post_ramp_start_pulses = null;   // post-ramp odometry baseline
        }
        else if (white_rabbit.dock.dock_state === "docked") {
            // start the undocking process by moving the white_rabbit forward off the dock
            // Forward off the dock — publish the drive command so compass
            // auto-calibration can run on the straight undock run.
            white_rabbit.motor.motor_speed_cmd    = motor_speed_cmd;
            white_rabbit.motor.motor_speed_cmd_ts = Date.now();
            white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "undock_white_rabbit");

            var pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.dock_pitch;

            // Enter ramp state once pitch departs enough from the original dock pitch.
            if (Math.abs(pitch_delta) >= ramp_detect_pitch_delta) {
                white_rabbit.dock.dock_state = "undocking_ramp";
                white_rabbit.dock.ramp_started_at = Date.now();
                console.log("White_rabbit going down the ramp");
            }
            else if (Date.now() - white_rabbit.dock.docked_state_started_at >= docked_state_timeout_ms) {
                // Flat-ground / no-ramp case: assume we've driven clear and let
                // the "undocked" state handle the final post-ramp drive.
                white_rabbit.dock.dock_state = "undocked";
                console.log("No ramp detected within " + docked_state_timeout_ms + "ms — assuming flat-ground undock");
            }
        }
        else if (white_rabbit.dock.dock_state === "undocking_ramp") {
            
            // white_rabbit is down the rabbit hole/ramp, so steer based on the IR lock to keep it centered as it continues down

            if (white_rabbit.irlock && white_rabbit.irlock.detected && white_rabbit.irlock.target) {
                var reverse_steer = white_rabbit.angle_to_pwm(white_rabbit.irlock.target.angle_x);
                white_rabbit.servo_send_command(white_rabbit, 11, reverse_steer.servo1, true);
                white_rabbit.servo_send_command(white_rabbit, 13, reverse_steer.servo2, true);
            } else {
                white_rabbit.servo_send_command(white_rabbit, 11, 1500, true);
                white_rabbit.servo_send_command(white_rabbit, 13, 1500, true);
            }

            //continue moving the white_rabbit down the ramp
            // Forward off the dock — publish the drive command so compass
            // auto-calibration can run on the straight undock run.
            white_rabbit.motor.motor_speed_cmd    = motor_speed_cmd;
            white_rabbit.motor.motor_speed_cmd_ts = Date.now();
            white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "undock_white_rabbit");

            var ramp_pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.dock_pitch;
            var on_ramp_long_enough = white_rabbit.dock.ramp_started_at && (Date.now() - white_rabbit.dock.ramp_started_at > 1000);

            // Debounce the "back to level" condition: pitch must hold within tolerance
            // for ramp_level_hold_ms continuously. A single noisy pitch sample mid-ramp
            // no longer ends the ramp early (which had stopped Noah and raised the arm
            // halfway down the ramp).
            var level_now = Math.abs(ramp_pitch_delta) <= level_pitch_tolerance;
            if (level_now) {
                if (!white_rabbit.dock.ramp_level_since) white_rabbit.dock.ramp_level_since = Date.now();
            } else {
                white_rabbit.dock.ramp_level_since = null;
            }
            var level_sustained = white_rabbit.dock.ramp_level_since
                && (Date.now() - white_rabbit.dock.ramp_level_since >= ramp_level_hold_ms);

            if (on_ramp_long_enough && level_sustained) {
                white_rabbit.dock.dock_state = "undocked";
                white_rabbit.dock.ramp_level_since = null;
                console.log("White_rabbit finished going down the ramp");
            }


        }
        else if(white_rabbit.dock.dock_state === "undocked"){

            if (white_rabbit.irlock && white_rabbit.irlock.detected && white_rabbit.irlock.target) {
                var reverse_steer = white_rabbit.angle_to_pwm(white_rabbit.irlock.target.angle_x);
                white_rabbit.servo_send_command(white_rabbit, 11, reverse_steer.servo1, true);
                white_rabbit.servo_send_command(white_rabbit, 13, reverse_steer.servo2, true);
            } else {
                white_rabbit.servo_send_command(white_rabbit, 11, 1500, true);
                white_rabbit.servo_send_command(white_rabbit, 13, 1500, true);
            }

            //Continue moving the white_rabbit forward for a short time to ensure it is clear of the dock
            // Forward off the dock — publish the drive command so compass
            // auto-calibration can run on the straight undock run.
            white_rabbit.motor.motor_speed_cmd    = motor_speed_cmd;
            white_rabbit.motor.motor_speed_cmd_ts = Date.now();
            white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "undock_white_rabbit");

            // Drive post_ramp_drive_m (default 2 m) past the bottom of the ramp,
            // measured by wheel odometry, before fixing the return point. Snapshot
            // the encoder baseline once on entry to this state.
            if (!white_rabbit.dock.post_ramp_start_pulses) {
                white_rabbit.dock.post_ramp_start_pulses = odo_snapshot(white_rabbit);
                white_rabbit.dock.post_ramp_started_at    = Date.now();
            }

            var traveled_m   = odo_distance_m(white_rabbit, white_rabbit.dock.post_ramp_start_pulses);
            var reached_dist = (traveled_m !== null) && (traveled_m >= post_ramp_drive_m);
            // Fallback so undock can't hang if encoder feedback is unavailable.
            var reached_time = white_rabbit.dock.post_ramp_started_at
                && (Date.now() - white_rabbit.dock.post_ramp_started_at) >= post_ramp_fallback_ms;

            if (reached_dist || reached_time) {
                white_rabbit.dock.dock_state = "undocked_completed";
                console.log("Drove " + (traveled_m !== null ? traveled_m.toFixed(2) + ' m' : '(time fallback)')
                    + " past the ramp — fixing return point and raising arm");
            }
        }
        else if (white_rabbit.dock.dock_state === "undocked_completed") {

            // Safety: clear any lingering undock timeout so re-entry can't fire a second one.
            if (white_rabbit.dock.undock_complete_timeout) {
                clearTimeout(white_rabbit.dock.undock_complete_timeout);
                white_rabbit.dock.undock_complete_timeout = null;
            }

            //Record the location of the undock for later use
            white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
            white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
            white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
            white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);

            //Stop the white_rabbit after undocking
            white_rabbit.motor.motor_speed_cmd = 0;
            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "undock_white_rabbit");

            // Stop undock loop once completed.
            if (white_rabbit.dock.undock_interval) {
                clearInterval(white_rabbit.dock.undock_interval);
                white_rabbit.dock.undock_interval = null;
            }

            //raise the arm after undocking to load the package onto the white_rabbit
            white_rabbit.create_arduino_message(white_rabbit, 'arm', 150);

            console.log("Undock complete, white_rabbit is now free from the dock");

            // If the mission switch was already asserted, or gets asserted while
            // undocking, start mission now that the rover is clear.
            if (white_rabbit.rc_contoller && white_rabbit.rc_contoller.mission_start_pending && !white_rabbit.robot_data.mission_mode) {
                if (!white_rabbit.rc_contoller.connected) {
                    console.log("Mission start blocked after undock: RC controller not connected");
                    return;
                }
                white_rabbit.rc_contoller.mission_start_pending = false;
                white_rabbit.robot_data.mission_mode = true;
                white_rabbit.dock.manual_dock_required = false;
                white_rabbit.mission.first_leg_committed = false;
                white_rabbit.mission.first_leg_start_lat = white_rabbit.robot_data.robot_latitude || null;
                white_rabbit.mission.first_leg_start_lng = white_rabbit.robot_data.robot_longitude || null;
                white_rabbit.mission.path_clear = true;
                white_rabbit.mission.avoidance_timed_out = false;
                white_rabbit.mission.realsense_blocked_since = null;
                white_rabbit.mission.avoidance_start_grace_until = Date.now() + 4000;
                white_rabbit.mission.avoidance_turn = null;
                // Defensive: don't double-spawn if mission_interval is somehow already running.
                if (white_rabbit.mission.mission_interval) {
                    clearInterval(white_rabbit.mission.mission_interval);
                }
                white_rabbit.mission.mission_interval = setInterval(() => {
                    white_rabbit.run_mission(white_rabbit);
                }, 250);
                if (white_rabbit.compass_calibration) white_rabbit.compass_calibration.start();
                if (white_rabbit.heading_belief) white_rabbit.heading_belief.reset();
                if (white_rabbit.waypoint_progress_monitor) white_rabbit.waypoint_progress_monitor.reset(white_rabbit);
                if (white_rabbit.sensor_coherence) white_rabbit.sensor_coherence.start();
                if (white_rabbit.vision_belief) white_rabbit.vision_belief.reset();
                console.log("Mission started after undocking");
            }
        }


    } else {
        console.log("White_rabbit is disarmed.");
    };

};

module.exports = undock_white_rabbit;
