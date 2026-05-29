var dock_white_rabbit = function (white_rabbit) {

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
			white_rabbit.dock.follow_state = {};   // reset IRLock follow state each dock attempt

			// Record ground pose once at dock start for pitch/heading reference.
			white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
			white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
			white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
			white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);

			white_rabbit.dock.ramp_started_at = null;
			white_rabbit.dock.docking_ground_started_at = Date.now();
		}
		else if (white_rabbit.dock.dock_state === "docking_ground") {
			// Engage follow_the_light if the beacon is fresh OR if it has already started
			// (follow_state.phase is set).  Once engaged we never drop back to the pitch-based
			// fallback — follow_the_light manages its own beacon-loss recovery internally and
			// sets dock_state = 'docked_completed' when done.
			const followEngaged = white_rabbit.dock.follow_state && white_rabbit.dock.follow_state.phase;
			const irlockFresh   = white_rabbit.irlock && white_rabbit.irlock.connected
					&& white_rabbit.irlock_message_handler.is_fresh(white_rabbit);

			if (followEngaged || irlockFresh) {
				white_rabbit.follow_the_light(white_rabbit);
				return;
			}

			// Beacon never acquired — fall back to pitch-based approach.
			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "dock_white_rabbit");

			var pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.undock_pitch;

			// Enter ramp state once pitch departs enough from initial ground pitch.
			if (Math.abs(pitch_delta) >= ramp_detect_pitch_delta) {
				white_rabbit.dock.dock_state = "docking_ramp";
				white_rabbit.dock.ramp_started_at = Date.now();
				console.log("White_rabbit going up the ramp");
			} else if (white_rabbit.dock.docking_ground_started_at &&
					(Date.now() - white_rabbit.dock.docking_ground_started_at >= docking_ground_timeout_ms)) {
				console.log("Docking ground timeout — stopping motors, dock attempt failed");
				white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "dock_white_rabbit");
				white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "dock_white_rabbit");
				white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "dock_white_rabbit");
				white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "dock_white_rabbit");
				if (white_rabbit.dock.dock_interval) {
					clearInterval(white_rabbit.dock.dock_interval);
					white_rabbit.dock.dock_interval = null;
				}
				white_rabbit.dock.dock_state = "docking_failed";
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_ramp") {
			// Continue backing up while climbing ramp.
			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "dock_white_rabbit");

			var ramp_pitch_delta = white_rabbit.get_pitch(white_rabbit) - white_rabbit.dock.undock_pitch;
			var on_ramp_long_enough = white_rabbit.dock.ramp_started_at && (Date.now() - white_rabbit.dock.ramp_started_at > 1000);

			// Consider ramp complete when pitch settles near initial level after at least 1s on ramp.
			if (on_ramp_long_enough && Math.abs(ramp_pitch_delta) <= level_pitch_tolerance) {
				white_rabbit.dock.dock_state = "docking_top";
				console.log("White_rabbit reached top of the ramp");
			}
		}
		else if (white_rabbit.dock.dock_state === "docking_top") {
			// Continue backing up for 3 seconds after reaching top of ramp.
			white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * -1, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "dock_white_rabbit");

			if (!white_rabbit.dock.dock_complete_timeout) {
				white_rabbit.dock.dock_complete_timeout = setTimeout(() => {
					white_rabbit.dock.dock_state = "docked_completed";
					white_rabbit.dock.dock_complete_timeout = null;
					console.log("White_rabbit finished docking drive at top of ramp");
				}, post_ramp_drive_ms);
			}
		}
		else if (white_rabbit.dock.dock_state === "docked_completed") {
			// Record final dock pose.
			white_rabbit.dock.dock_latitude = white_rabbit.robot_data.robot_latitude;
			white_rabbit.dock.dock_longitude = white_rabbit.robot_data.robot_longitude;
			white_rabbit.dock.dock_pitch = white_rabbit.get_pitch(white_rabbit);
			white_rabbit.dock.dock_heading = white_rabbit.get_heading(white_rabbit);

			// Stop white_rabbit.
			white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "dock_white_rabbit");
			white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "dock_white_rabbit");

			// Stop dock loop once completed.
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

module.exports = dock_white_rabbit;
