var reset_white_rabbit = function (white_rabbit) {

	console.log('reset_white_rabbit: Resetting White_rabbit Params!');

	// Cancel any in-flight delivery timer before clearing auto_delivery —
	// the setTimeout in yaw_white_rabbit_for_package_delivery would otherwise
	// re-set auto_delivery to true on the next mission after a mid-delivery reset.
	if (white_rabbit.mission._auto_delivery_timer) {
		clearTimeout(white_rabbit.mission._auto_delivery_timer);
		white_rabbit.mission._auto_delivery_timer = null;
	}

	white_rabbit.mission.mission_count = 0;
	white_rabbit.mission.waypoints = [];
	white_rabbit.flight_mode_trigger = null;
	white_rabbit.mission.package_delivered = null;
	white_rabbit.mission.current_mission_seq = 0;
	white_rabbit.motor.last_motor_speed_cmd = 0;
	white_rabbit.mission.auto_delivery = false;
	white_rabbit.mission.package_delivery_yaw = null;
	white_rabbit.mission.finished_package_yaw = null;
	white_rabbit.mission.pause_mission = false;
	white_rabbit.mission.path_clear = false;
	white_rabbit.mission.realsense_blocked_since = null;
	white_rabbit.mission.avoidance_timed_out = false;
	if (white_rabbit.mission.memory_watchdog) white_rabbit.mission.memory_watchdog.recovery_state = false;
	white_rabbit.dock.dock_state = null;

};


module.exports = reset_white_rabbit;