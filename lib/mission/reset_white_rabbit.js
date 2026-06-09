var reset_white_rabbit = function (white_rabbit) {

	console.log('reset_white_rabbit: Resetting White_rabbit Params!');

	// Cancel any in-flight delivery timers before clearing auto_delivery —
	// the setTimeouts in yaw_white_rabbit_for_package_delivery would otherwise
	// re-set auto_delivery to true on the next mission after a mid-delivery reset.
	if (white_rabbit.mission._auto_delivery_timer) {
		clearTimeout(white_rabbit.mission._auto_delivery_timer);
		white_rabbit.mission._auto_delivery_timer = null;
	}
	if (white_rabbit.mission._delivery_confirm_timeout) {
		clearTimeout(white_rabbit.mission._delivery_confirm_timeout);
		white_rabbit.mission._delivery_confirm_timeout = null;
	}

	white_rabbit.mission.mission_count = 0;
	white_rabbit.mission.waypoints = [];
	white_rabbit.mission.breadcrumb_path = [];
	white_rabbit.mission.breadcrumb_return_index = -1;
	white_rabbit.mission.breadcrumb_last_record_ts = 0;
	white_rabbit.flight_mode_trigger = null;
	white_rabbit.mission.package_delivered = null;
	white_rabbit.mission.current_mission_seq = 0;
	white_rabbit.motor.last_motor_speed_cmd = 0;
	white_rabbit.mission.auto_delivery = false;
	white_rabbit.mission.package_delivery_yaw = null;
	white_rabbit.mission.finished_package_yaw = null;
	white_rabbit.mission.dock_return_phase = null;
	white_rabbit.mission.pause_mission = false;
	white_rabbit.mission.first_leg_committed = false;
	white_rabbit.mission.first_leg_start_lat = null;
	white_rabbit.mission.first_leg_start_lng = null;
	// path_clear starts false so the avoid_object loop must verify the corridor is
	// clear before the mission moves. But when LiDAR obstacle avoidance is disabled,
	// avoid_object returns early and never flips path_clear back to true — leaving the
	// mission permanently stuck (can't start). With avoidance off, default to clear.
	white_rabbit.mission.path_clear = !(white_rabbit.rplidar && white_rabbit.rplidar.avoid_object);
	white_rabbit.mission.realsense_blocked_since = null;
	white_rabbit.mission.avoidance_timed_out = false;
	// Sidewalk-following starts OFF every mission; the >90° gate waypoint turns it on.
	white_rabbit.mission.sidewalk_follow_active = false;
	white_rabbit.mission.sidewalk_deliver_triggered = false;
	if (white_rabbit.mission.nav_control) {
		white_rabbit.mission.nav_control.sidewalk_seeking = false;
		white_rabbit.mission.nav_control.sidewalk_seek_enter_ts = null;
		white_rabbit.mission.nav_control.sidewalk_seek_exit_ts = null;
	}
	if (white_rabbit.mission.memory_watchdog) white_rabbit.mission.memory_watchdog.recovery_state = false;
	white_rabbit.dock.dock_state = null;
	white_rabbit.dock.manual_dock_required = false;
	white_rabbit.dock.awaiting_stow_ack = false;
	white_rabbit.dock.stow_confirmed = false;
	white_rabbit.mission.dock_align_start_ts = null;
	white_rabbit.mission.balance_halt = false;
	white_rabbit.mission._balance_halt_announced = false;
	white_rabbit.mission._last_waypoint_bearing = null;
	white_rabbit.mission._last_nav_heading = null;
	white_rabbit.mission._breadcrumb_stall_idx  = null;
	white_rabbit.mission._breadcrumb_stall_ts   = null;
	white_rabbit.mission.power_abort            = false;
	white_rabbit.mission._power_start_voltage_v = null;
	white_rabbit.mission._power_last_lat        = null;
	white_rabbit.mission._power_last_lng        = null;
	white_rabbit.mission._power_odometer_m      = 0;

};


module.exports = reset_white_rabbit;