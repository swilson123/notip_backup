var reset_white_rabbit = function (white_rabbit) {

	console.log('reset_white_rabbit: Resetting White_rabbit Params!');

	white_rabbit.mission.mission_count = 0;
	white_rabbit.mission.waypoints = [];
	white_rabbit.flight_mode_trigger = null;
	white_rabbit.mission.package_delivered = null;
	white_rabbit.mission.current_mission_seq = 0;
	white_rabbit.motor.last_motor_speed_cmd = 0;
	white_rabbit.mission.auto_delivery = false;
	white_rabbit.mission.package_delivery_yaw = null;
	white_rabbit.mission.finished_package_yaw = null;
	white_rabbit.dock.dock_state = null;

};


module.exports = reset_white_rabbit;