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

		if (!white_rabbit.dock.dock_state) {
			if (white_rabbit.voice) white_rabbit.voice.say('Searching for the light.');
			console.log("get undock lat/lng/pitch/heading");
			white_rabbit.dock.dock_state = "searching_for_the_light";
			// Clear any stale belief from a prior dock attempt.
			if (white_rabbit.irlock_belief) white_rabbit.irlock_belief.reset();

			white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
			white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
			white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
			white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);

			white_rabbit.dock.ramp_started_at = null;
			white_rabbit.dock.docking_ground_started_at = Date.now();
			white_rabbit.dock.search_started_at = Date.now();
		}
		else if (white_rabbit.dock.dock_state === "searching_for_the_light") {
			console.log("Searching for the light.");
			if (white_rabbit.irlock.detected && white_rabbit.irlock.target) {
				white_rabbit.dock.dock_state = "docking_ground";
				if (white_rabbit.voice) white_rabbit.voice.say('Light acquired. Docking.');
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
				// white_rabbit.servo_send_command(white_rabbit, 11, 1750, false);
				// white_rabbit.servo_send_command(white_rabbit, 12, 1750, false);
				// white_rabbit.servo_send_command(white_rabbit, 13, 1750, false);
				// white_rabbit.servo_send_command(white_rabbit, 14, 1750, false);

				// white_rabbit.move_white_rabbit(white_rabbit, 1, search_spin_speed_cmd, "follow_the_light");
				// white_rabbit.move_white_rabbit(white_rabbit, 2, search_spin_speed_cmd, "follow_the_light");
				// white_rabbit.move_white_rabbit(white_rabbit, 3, search_spin_speed_cmd, "follow_the_light");
				// white_rabbit.move_white_rabbit(white_rabbit, 4, search_spin_speed_cmd, "follow_the_light");
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_ground") {

			// Update IRLock belief before reading — compass-compensates the stored
			// angle for any yaw that happened since the light was last seen.
			if (white_rabbit.irlock_belief) white_rabbit.irlock_belief(white_rabbit);

			const ground_fresh   = white_rabbit.irlock.detected && white_rabbit.irlock.target;
			const ground_believed_x = white_rabbit.irlock.believed_x;

			if (ground_fresh) {

				white_rabbit.dock.light_lost_since = null;   // beacon visible — clear loss timer

				var reverse_steer = white_rabbit.angle_to_pwm(-white_rabbit.irlock.target.angle_x);

				white_rabbit.servo_send_command(white_rabbit, 12, reverse_steer.servo1, true);
				white_rabbit.servo_send_command(white_rabbit, 14, reverse_steer.servo2, true);

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

			} else if (ground_believed_x !== null) {

				// Beacon is blinking — steer toward the compass-compensated believed
				// angle instead of driving blind-center. Noah knows where the light is.
				if (!white_rabbit.dock.light_lost_since) {
					white_rabbit.dock.light_lost_since = Date.now();
				}

				if (Date.now() - white_rabbit.dock.light_lost_since >= 2000) {
					// Blink lasted too long — abort and search again.
					white_rabbit.dock.dock_state = "searching_for_the_light";
					white_rabbit.dock.search_started_at = Date.now();
					white_rabbit.dock.light_lost_since = null;
					if (white_rabbit.voice) white_rabbit.voice.say('Lost the light. Searching again.');
				} else {
					// Still within grace window — steer toward where the light was.
					var blink_steer = white_rabbit.angle_to_pwm(-ground_believed_x);
					white_rabbit.servo_send_command(white_rabbit, 12, blink_steer.servo1, true);
					white_rabbit.servo_send_command(white_rabbit, 14, blink_steer.servo2, true);
					white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");
				}

			} else {
				// No beacon and no belief — require 2 s before triggering a full search.
				if (!white_rabbit.dock.light_lost_since) {
					white_rabbit.dock.light_lost_since = Date.now();
				}

				if (Date.now() - white_rabbit.dock.light_lost_since >= 2000) {
					white_rabbit.dock.dock_state = "searching_for_the_light";
					white_rabbit.dock.search_started_at = Date.now();
					white_rabbit.dock.light_lost_since = null;
					if (white_rabbit.voice) white_rabbit.voice.say('Lost the light. Searching again.');
				} else {
					// Hold straight — no angle to aim at.
					white_rabbit.servo_send_command(white_rabbit, 12, 1500, true);
					white_rabbit.servo_send_command(white_rabbit, 14, 1500, true);
					white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
					white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");
				}
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_ramp") {

			// Update belief on the ramp too — beacon can blink close-up.
			if (white_rabbit.irlock_belief) white_rabbit.irlock_belief(white_rabbit);

			const ramp_fresh      = white_rabbit.irlock.detected && white_rabbit.irlock.target;
			const ramp_believed_x = white_rabbit.irlock.believed_x;
			const ramp_angle_x    = ramp_fresh
			                        ? white_rabbit.irlock.target.angle_x
			                        : ramp_believed_x;   // null if belief expired

			if (ramp_angle_x !== null && ramp_angle_x !== undefined) {
				var ramp_steer = white_rabbit.angle_to_pwm(-ramp_angle_x);
				white_rabbit.servo_send_command(white_rabbit, 12, ramp_steer.servo1, true);
				white_rabbit.servo_send_command(white_rabbit, 14, ramp_steer.servo2, true);
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
