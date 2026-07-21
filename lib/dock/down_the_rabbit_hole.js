var down_the_rabbit_hole = function (white_rabbit) {
    if (white_rabbit.robot_data.is_armed) {
        // Wait until the active pitch source (the one get_pitch will read) has arrived —
        // dock_pitch is captured once at undock start and a stale reading would break
        // ramp detection. IMU when enable_imu, otherwise the Pixhawk ATTITUDE.
        var _pitch_ready = white_rabbit.get_pitch(white_rabbit);
        if (!_pitch_ready) {
            console.log("Undock waiting for attitude data");
            return;
        }


        var motor_speed_cmd = 25;
        var ramp_detect_pitch_delta = 0.12; // ~6.9 deg
        var level_pitch_tolerance = 0.07;   // ~4.0 deg
        // Distance to drive past the bottom of the ramp before stopping. The point
        // reached here is the recorded undock lat/lng/heading the rover returns to.
        var post_ramp_drive_distance_m = (white_rabbit.irlock && white_rabbit.irlock.follow_config
            && typeof white_rabbit.irlock.follow_config.post_ramp_drive_distance_m === 'number')
            ? white_rabbit.irlock.follow_config.post_ramp_drive_distance_m : 2.0;
        // Wheel odometry geometry (same drivetrain the voice nudges measure with):
        // distance_m = avg|Δpulses| / (cpr / (π·wheel_diameter)). Encoder pulses are
        // exact integer counts, so this is far more accurate than GPS at ~2 m.
        var vcfg = white_rabbit.voice_config || {};
        var wheel_diam_m = typeof vcfg.wheel_diameter_m === 'number' ? vcfg.wheel_diameter_m : 0.254;
        var cpr = typeof vcfg.cpr_pulses_per_rev === 'number' ? vcfg.cpr_pulses_per_rev : 16385;
        var pulses_per_m = cpr / (Math.PI * wheel_diam_m);
        // Safety fallback: if encoders never report 2 m of travel (feedback frozen),
        // stop after this long anyway rather than driving forward forever.
        var post_ramp_drive_timeout_ms = 20000;
        // If the white_rabbit never detects a ramp (parked on flat ground, missing
        // ramp, noisy pitch sensor), bail to "undocked" rather than driving
        // forward at speed 25 forever.
        var docked_state_timeout_ms = 5000;

        if (!white_rabbit.dock.dock_state) {
            console.log("Undocking White_rabbit");
            if (white_rabbit.voice) white_rabbit.voice.say('Noah Undocking');
            white_rabbit.dock.dock_state = "docked";
            white_rabbit.dock.docked_state_started_at = Date.now();

            // Record initial dock pose once at undock start.
            white_rabbit.dock.dock_latitude = white_rabbit.robot_data.robot_latitude;
            white_rabbit.dock.dock_longitude = white_rabbit.robot_data.robot_longitude;
            white_rabbit.dock.dock_pitch = white_rabbit.get_pitch(white_rabbit);
            white_rabbit.dock.dock_heading = white_rabbit.get_heading(white_rabbit);

            white_rabbit.dock.ramp_started_at = null;

            // Reset post-ramp 2 m drive tracking for a clean undock run.
            white_rabbit.dock.post_ramp_start_pulses = null;
            white_rabbit.dock.post_ramp_start_pose = null;
            white_rabbit.dock.post_ramp_started_at = null;
        }
        else if (white_rabbit.dock.dock_state === "docked") {
            // start the undocking process by moving the white_rabbit forward off the dock
            white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
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
                //if (white_rabbit.voice) white_rabbit.voice.say('Going down the rabbit hole');
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
            // (nav_tuning.steering_trim_deg corrects the same left-hugging pull seen on the sidewalk in carrot.js)

            if (white_rabbit.irlock && white_rabbit.irlock.detected && white_rabbit.irlock.target) {


			    white_rabbit.motor.steering_angle_deg = white_rabbit.irlock.target.angle_x / 2;
                var steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, white_rabbit.motor.steering_angle_deg, motor_speed_cmd);

                // Reported back so the RC edge-capture logger (radio_commands.js) can record what
                // Noah actually commanded during an autonomous (mission_mode) pass, instead of the
                // idle RC stick position.
                white_rabbit.motor.servo_angles_deg = steering_and_rpm.servo_angles_deg;
                white_rabbit.motor.speed_cmd = motor_speed_cmd;

                //Send steer command to Noah..............................
                white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
                white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
                white_rabbit.servo_send_command(white_rabbit, 12, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
                white_rabbit.servo_send_command(white_rabbit, 14, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);


                //MOTOR SPEED...................................................................
                //motor speed command is based on confidence of path detection.  If confidence is low, the speed is reduced to allow for more time to detect the path.
                white_rabbit.motor.moving = true;
                white_rabbit.move_white_rabbit(white_rabbit, 1, steering_and_rpm.motor_rpm.front_passenger, "down_the_rabbit_hole");
                white_rabbit.move_white_rabbit(white_rabbit, 2, steering_and_rpm.motor_rpm.back_passenger, "down_the_rabbit_hole");
                white_rabbit.move_white_rabbit(white_rabbit, 3, steering_and_rpm.motor_rpm.front_driver, "down_the_rabbit_hole");
                white_rabbit.move_white_rabbit(white_rabbit, 4, steering_and_rpm.motor_rpm.back_driver, "down_the_rabbit_hole");
		

            }

            // if (white_rabbit.irlock && white_rabbit.irlock.detected && white_rabbit.irlock.target) {
            //     white_rabbit.dock.steer_lost_since = null;
            //     var reverse_steer = white_rabbit.angle_to_pwm(white_rabbit.irlock.target.angle_x);
            //     white_rabbit.dock.last_steer = reverse_steer;
            //     white_rabbit.servo_send_command(white_rabbit, 11, reverse_steer.servo1, false);
            //     white_rabbit.servo_send_command(white_rabbit, 13, reverse_steer.servo2, false);
            //     white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
            //     white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
            // } else {
            //     if (!white_rabbit.dock.steer_lost_since) {
            //         white_rabbit.dock.steer_lost_since = Date.now();
            //     }
            //     var held = (Date.now() - white_rabbit.dock.steer_lost_since < 500 && white_rabbit.dock.last_steer);
            //     white_rabbit.servo_send_command(white_rabbit, 11, held ? white_rabbit.dock.last_steer.servo1 : 1500, false);
            //     white_rabbit.servo_send_command(white_rabbit, 13, held ? white_rabbit.dock.last_steer.servo2 : 1500, false);
            //     white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
            //     white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
            // }

            // //continue moving the white_rabbit down the ramp
            // white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "undock_white_rabbit");
            // white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "undock_white_rabbit");
            // white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "undock_white_rabbit");
            // white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "undock_white_rabbit");

            var ramp_pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.dock_pitch;
            var on_ramp_long_enough = white_rabbit.dock.ramp_started_at && (Date.now() - white_rabbit.dock.ramp_started_at > 1000);

            // Consider ramp complete when pitch settles near initial level after at least 1s on ramp.
            if (on_ramp_long_enough && Math.abs(ramp_pitch_delta) <= level_pitch_tolerance) {
                white_rabbit.dock.dock_state = "undocked";
                console.log("White_rabbit finished going down the ramp");
            }


        }
        else if (white_rabbit.dock.dock_state === "undocked") {


            white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);


            //Continue moving the white_rabbit forward off the bottom of the ramp.
            white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "undock_white_rabbit");
            white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "undock_white_rabbit");

            // Snapshot the per-wheel encoder pulse counts at the bottom of the ramp
            // once, then drive post_ramp_drive_distance_m (2 m) past it measured by
            // wheel odometry. That 2 m point becomes the recorded undock
            // location/heading and is where the arm raises.
            // Start the safety timer on first entry regardless, so a frozen/absent
            // encoder feed can't leave the rover driving forward forever.
            if (white_rabbit.dock.post_ramp_started_at == null) {
                white_rabbit.dock.post_ramp_started_at = Date.now();
            }
            var pulses_now = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
            if (white_rabbit.dock.post_ramp_start_pulses == null && pulses_now) {
                white_rabbit.dock.post_ramp_start_pulses = {
                    1: pulses_now[1] | 0, 2: pulses_now[2] | 0,
                    3: pulses_now[3] | 0, 4: pulses_now[4] | 0
                };
                // Snapshot pose at the bottom of the ramp. The straight post-ramp
                // drive that follows is the first compass-calibration segment, run
                // at undocked_completed before the undock heading is recorded.
                white_rabbit.dock.post_ramp_start_pose = {
                    lat: white_rabbit.robot_data.robot_latitude,
                    lng: white_rabbit.robot_data.robot_longitude,
                    raw_heading: white_rabbit.get_heading(white_rabbit)
                };
            }

            var post_ramp_driven_m = 0;
            if (white_rabbit.dock.post_ramp_start_pulses && pulses_now) {
                var start_pulses = white_rabbit.dock.post_ramp_start_pulses;
                var sum_abs_delta = 0;
                for (var _id = 1; _id <= 4; _id++) {
                    sum_abs_delta += Math.abs((pulses_now[_id] | 0) - start_pulses[_id]);
                }
                post_ramp_driven_m = (sum_abs_delta / 4) / pulses_per_m;
            }

            var post_ramp_timed_out = white_rabbit.dock.post_ramp_started_at
                && (Date.now() - white_rabbit.dock.post_ramp_started_at) >= post_ramp_drive_timeout_ms;

            if (post_ramp_driven_m >= post_ramp_drive_distance_m || post_ramp_timed_out) {
                white_rabbit.dock.dock_state = "undocked_completed";
                console.log(post_ramp_timed_out
                    ? ("White_rabbit post-ramp drive timed out after " + post_ramp_drive_timeout_ms + "ms (" + post_ramp_driven_m.toFixed(2) + "m) — stopping")
                    : ("White_rabbit drove " + post_ramp_driven_m.toFixed(2) + "m past the ramp — clear of the dock"));
            }
        }
        else if (white_rabbit.dock.dock_state === "undocked_completed") {

            // Safety: clear any lingering undock timeout so re-entry can't fire a second one.
            if (white_rabbit.dock.undock_complete_timeout) {
                clearTimeout(white_rabbit.dock.undock_complete_timeout);
                white_rabbit.dock.undock_complete_timeout = null;
            }

            // Calibrate the compass off the straight post-ramp drive BEFORE
            // recording the undock heading, so the recorded heading uses the
            // fresh offset. Distance measured by the same wheel odometry.
            var undock_pulses_now = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
            if (white_rabbit.compass_calibration
                && typeof white_rabbit.compass_calibration.calibrate_undock_segment === 'function'
                && white_rabbit.dock.post_ramp_start_pose && white_rabbit.dock.post_ramp_start_pulses && undock_pulses_now) {
                var undock_odo_m = 0;
                for (var _cid = 1; _cid <= 4; _cid++) {
                    undock_odo_m += Math.abs((undock_pulses_now[_cid] | 0) - white_rabbit.dock.post_ramp_start_pulses[_cid]);
                }
                undock_odo_m = (undock_odo_m / 4) / pulses_per_m;
                white_rabbit.compass_calibration.calibrate_undock_segment(
                    white_rabbit, white_rabbit.dock.post_ramp_start_pose, undock_odo_m);
            }

            //Record the location of the undock for later use
            white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
            white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
            white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
            white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);

            //Stop the white_rabbit after undocking
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
                console.log("Mission started after undocking");
            }
        }


    } else {
        console.log("White_rabbit is disarmed.");
    };

};

module.exports = down_the_rabbit_hole;
