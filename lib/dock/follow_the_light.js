var follow_the_light = function (white_rabbit) {

	if (white_rabbit.robot_data.is_armed) {
		if (!white_rabbit.imu_data.connected || !white_rabbit.robot_data.ATTITUDE) {
			console.log("Dock waiting for ATTITUDE message");
			return;
		}

		var motor_speed_cmd = 25;
		var search_spin_speed_cmd = 35;
		var ramp_detect_pitch_delta = 0.12; // ~6.9 deg
		var level_pitch_tolerance = 0.07;   // ~4.0 deg
		var post_ramp_drive_ms = 3000;
		var docking_ground_timeout_ms = 60000;
		var search_timeout_ms = 60000;   // give up the light search after 60 s of spinning

		// Wheel odometry geometry — same drivetrain constants used by the voice nudge and undock drives.
		var vcfg = white_rabbit.voice_config || {};
		var wheel_diam_m = typeof vcfg.wheel_diameter_m === 'number' ? vcfg.wheel_diameter_m : 0.254;
		var cpr = typeof vcfg.cpr_pulses_per_rev === 'number' ? vcfg.cpr_pulses_per_rev : 16385;
		var pulses_per_m = cpr / (Math.PI * wheel_diam_m);

		// Distance to drive forward toward the dock before spinning to search for the light.
		// Measured by wheel odometry. Configurable via irlock.pre_search_drive_m in setup.json.
		var pre_search_drive_m = (white_rabbit.irlock && white_rabbit.irlock.follow_config
			&& typeof white_rabbit.irlock.follow_config.pre_search_drive_m === 'number')
			? white_rabbit.irlock.follow_config.pre_search_drive_m : 0.4572;  // default 1.5 ft

		if (!white_rabbit.dock.dock_state) {
			console.log("follow_the_light: arrived — driving " + pre_search_drive_m.toFixed(2) + "m before searching");
			if (white_rabbit.voice) white_rabbit.voice.say('Arrived. Advancing to search position.');
			white_rabbit.dock.dock_state = "pre_search_drive";

			white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
			white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
			white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
			white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);

			white_rabbit.dock.ramp_started_at = null;
			white_rabbit.dock.docking_ground_started_at = null;
			white_rabbit.dock.search_started_at = null;
			white_rabbit.dock.pre_search_start_pulses = null;
			white_rabbit.dock.pre_search_started_at = null;
		}
		else if (white_rabbit.dock.dock_state === "pre_search_drive") {
			// Straight wheels, drive forward toward the dock using wheel odometry.
			white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
			white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
			white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
			white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);

			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");

			if (white_rabbit.dock.pre_search_started_at == null) {
				white_rabbit.dock.pre_search_started_at = Date.now();
			}
			var psd_pulses = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
			if (white_rabbit.dock.pre_search_start_pulses == null && psd_pulses) {
				white_rabbit.dock.pre_search_start_pulses = {
					1: psd_pulses[1] | 0, 2: psd_pulses[2] | 0,
					3: psd_pulses[3] | 0, 4: psd_pulses[4] | 0
				};
			}

			var psd_driven_m = 0;
			if (white_rabbit.dock.pre_search_start_pulses && psd_pulses) {
				var psd_start = white_rabbit.dock.pre_search_start_pulses;
				var psd_sum = 0;
				for (var _pid = 1; _pid <= 4; _pid++) {
					psd_sum += Math.abs((psd_pulses[_pid] | 0) - psd_start[_pid]);
				}
				psd_driven_m = (psd_sum / 4) / pulses_per_m;
			}

			// Safety cap: 10 s regardless of odometry (handles frozen encoder feed).
			var psd_timed_out = (Date.now() - white_rabbit.dock.pre_search_started_at) >= 10000;

			if (psd_driven_m >= pre_search_drive_m || psd_timed_out) {
				if (psd_timed_out) console.log("follow_the_light: pre-search drive safety timeout");
				else console.log("follow_the_light: pre-search drive complete (" + psd_driven_m.toFixed(2) + "m)");
				white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "follow_the_light");
				white_rabbit.dock.dock_state = "searching_for_the_light";
				white_rabbit.dock.docking_ground_started_at = Date.now();
				white_rabbit.dock.search_started_at = Date.now();
				if (white_rabbit.voice) white_rabbit.voice.say('Searching for the light.');
			}
		}
		else if (white_rabbit.dock.dock_state === "searching_for_the_light") {
			console.log("Searching for the light.");
			if (white_rabbit.irlock.detected && white_rabbit.irlock.target) {
				white_rabbit.dock.dock_state = "docking_ground";
				if (white_rabbit.voice) white_rabbit.voice.say('Light acquired. Docking.');
				//set wheels straight for docking approach, and let the servo commands in the docking_ground state handle the steering adjustments from here.
				white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
				
			} else if (white_rabbit.dock.search_started_at &&
				(Date.now() - white_rabbit.dock.search_started_at >= search_timeout_ms)) {
				// Spun a full 60 s without acquiring the beacon — stop and give up.
				console.log("Search timeout — light not found, aborting dock.");
				white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "follow_the_light");
				// say() (not say_event) so the custom phrase actually speaks; urgent.
				if (white_rabbit.voice) white_rabbit.voice.say('Light not found. Docking failed.', true);
				if (white_rabbit.dock.dock_interval) {
					clearInterval(white_rabbit.dock.dock_interval);
					white_rabbit.dock.dock_interval = null;
				}
				white_rabbit.dock.dock_state = "docking_failed";
			} else {
				// No beacon yet — spin in place (clockwise) to sweep the full
				// circle until the IRLock light comes into view.
				// Use immediate spin commands here so search rotation is visible
				// even when steering-servos were previously far from spin geometry.
				console.log("Spinning to find the light...");
				if (white_rabbit.voice) white_rabbit.voice.say('Spinning to find the light...');
				white_rabbit.servo_send_command(white_rabbit, 11, 1750, false);
				white_rabbit.servo_send_command(white_rabbit, 12, 1750, false);
				white_rabbit.servo_send_command(white_rabbit, 13, 1750, false);
				white_rabbit.servo_send_command(white_rabbit, 14, 1750, false);

				white_rabbit.move_white_rabbit(white_rabbit, 1, search_spin_speed_cmd, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 2, search_spin_speed_cmd, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 3, search_spin_speed_cmd, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 4, search_spin_speed_cmd, "follow_the_light");
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_ground") {

			if (white_rabbit.irlock.detected && white_rabbit.irlock.target) {

				white_rabbit.dock.light_lost_since = null;   // beacon visible — clear loss timer

				var reverse_steer = white_rabbit.angle_to_pwm(-white_rabbit.irlock.target.angle_x);

				white_rabbit.servo_send_command(white_rabbit, 12, reverse_steer.servo1, false);
				white_rabbit.servo_send_command(white_rabbit, 14, reverse_steer.servo2, false);
				white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);

				white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
				white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");

				var pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.undock_pitch;

				if (Math.abs(pitch_delta) >= ramp_detect_pitch_delta) {
					white_rabbit.dock.dock_state = "docking_ramp";
					if (white_rabbit.voice) white_rabbit.voice.say('Going up the ramp.');
					white_rabbit.dock.ramp_started_at = Date.now();
					console.log("White_rabbit going up the ramp");
				} else if (white_rabbit.dock.docking_ground_started_at &&
					(Date.now() - white_rabbit.dock.docking_ground_started_at >= docking_ground_timeout_ms)) {
					console.log("Docking ground timeout — stopping motors, dock attempt failed");
					white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "follow_the_light");
					if (white_rabbit.dock.dock_interval) {
						clearInterval(white_rabbit.dock.dock_interval);
						white_rabbit.dock.dock_interval = null;
					}
					white_rabbit.dock.dock_state = "docking_failed";
				}

			} else {
				// Beacon lost — require 2 s of CONTINUOUS loss before abandoning the
				// approach, so a brief flicker doesn't bounce us back into a full search.
				if (!white_rabbit.dock.light_lost_since) {
					white_rabbit.dock.light_lost_since = Date.now();
				}

				if (Date.now() - white_rabbit.dock.light_lost_since >= 2000) {
					white_rabbit.dock.dock_state = "searching_for_the_light";
					white_rabbit.dock.search_started_at = Date.now();
					white_rabbit.dock.light_lost_since = null;
					if (white_rabbit.voice) white_rabbit.voice.say('Lost the light. Searching again.');
				} else {
					// Within the 2 s grace window — hold course (straight reverse toward
					// the dock) so a momentary dropout doesn't stall the approach.
					white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
					white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
					white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
				    white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
					white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");
				}
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_ramp") {
			if (white_rabbit.irlock.detected && white_rabbit.irlock.target) {
				white_rabbit.dock.steer_lost_since = null;
				var ramp_steer = white_rabbit.angle_to_pwm(-white_rabbit.irlock.target.angle_x);
				white_rabbit.dock.last_steer = ramp_steer;
				white_rabbit.servo_send_command(white_rabbit, 12, ramp_steer.servo1, false);
				white_rabbit.servo_send_command(white_rabbit, 14, ramp_steer.servo2, false);
				white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
			} else {
				if (!white_rabbit.dock.steer_lost_since) {
					white_rabbit.dock.steer_lost_since = Date.now();
				}
				var held = (Date.now() - white_rabbit.dock.steer_lost_since < 500 && white_rabbit.dock.last_steer);
				white_rabbit.servo_send_command(white_rabbit, 12, held ? white_rabbit.dock.last_steer.servo1 : 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 14, held ? white_rabbit.dock.last_steer.servo2 : 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
				white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
			}

			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");

			var ramp_pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.undock_pitch;
			var on_ramp_long_enough = white_rabbit.dock.ramp_started_at && (Date.now() - white_rabbit.dock.ramp_started_at > 1000);

			// Ramp timeout: if pitch never levels after 30s, advance anyway — better
			// to overshoot the top than drive up the ramp forever.
			var ramp_timed_out = white_rabbit.dock.ramp_started_at && (Date.now() - white_rabbit.dock.ramp_started_at > 30000);

			if (ramp_timed_out) {
				white_rabbit.dock.dock_state = "docking_top";
				console.log("follow_the_light: ramp timeout (30s) — advancing to docking_top");
				if (white_rabbit.voice) white_rabbit.voice.say('Ramp timeout. Proceeding to dock top.');
			} else if (on_ramp_long_enough && Math.abs(ramp_pitch_delta) <= level_pitch_tolerance) {
				white_rabbit.dock.dock_state = "docking_top";
				console.log("White_rabbit reached top of the ramp");
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_top") {
			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");

			if (!white_rabbit.dock.dock_complete_timeout) {
				white_rabbit.dock.dock_complete_timeout = setTimeout(() => {
					white_rabbit.dock.dock_state = "docked_completed";
					white_rabbit.dock.dock_complete_timeout = null;
					console.log("White_rabbit finished docking drive at top of ramp");

				}, post_ramp_drive_ms);
			}
		}
		else if (white_rabbit.dock.dock_state === "docked_completed") {
			white_rabbit.dock.dock_latitude = white_rabbit.robot_data.robot_latitude;
			white_rabbit.dock.dock_longitude = white_rabbit.robot_data.robot_longitude;
			white_rabbit.dock.dock_pitch = white_rabbit.get_pitch(white_rabbit);
			white_rabbit.dock.dock_heading = white_rabbit.get_heading(white_rabbit);

			white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "follow_the_light");

			if (white_rabbit.dock.dock_interval) {
				clearInterval(white_rabbit.dock.dock_interval);
				white_rabbit.dock.dock_interval = null;
			}

			white_rabbit.dock.dock_state = "docked";
			console.log("Dock complete, white_rabbit is in the rabbit hole.");
			if (white_rabbit.voice) white_rabbit.voice.say('Dock complete.');
		}
	} else {
		console.log("White_rabbit is disarmed.");
	}

};

module.exports = follow_the_light;
