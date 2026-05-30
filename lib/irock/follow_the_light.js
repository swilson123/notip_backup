var follow_the_light = function (white_rabbit) {

	if (white_rabbit.robot_data.is_armed) {
		if (!white_rabbit.imu_data.connected && !white_rabbit.robot_data.ATTITUDE) {
			console.log("Dock waiting for ATTITUDE message");
			return;
		}

		var motor_speed_cmd = 25;
		var ramp_detect_pitch_delta = 0.12; // ~6.9 deg
		var level_pitch_tolerance = 0.07;   // ~4.0 deg
		var post_ramp_drive_ms = 3000;
		var docking_ground_timeout_ms = 30000;

		if (!white_rabbit.dock.dock_state) {
			console.log("Docking White_rabbit");
			white_rabbit.dock.dock_state = "docking_ground";

			white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
			white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
			white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
			white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);

			white_rabbit.dock.ramp_started_at = null;
			white_rabbit.dock.docking_ground_started_at = Date.now();
		}
		else if (white_rabbit.dock.dock_state === "docking_ground") {


			
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
		}
		else if (white_rabbit.dock.dock_state === "docking_ramp") {
			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "follow_the_light");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "follow_the_light");

			var ramp_pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.undock_pitch;
			var on_ramp_long_enough = white_rabbit.dock.ramp_started_at && (Date.now() - white_rabbit.dock.ramp_started_at > 1000);

			if (on_ramp_long_enough && Math.abs(ramp_pitch_delta) <= level_pitch_tolerance) {
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
			console.log("Dock complete, white_rabbit is now on the dock");
		}
	} else {
		console.log("White_rabbit is disarmed.");
	}

};

module.exports = follow_the_light;
