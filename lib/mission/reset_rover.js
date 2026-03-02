var reset_rover = function (rover) {

	console.log('reset_rover: Resetting Rover Params!');

	rover.mission.mission_count = 0;
	rover.mission.waypoints = [];
	rover.flight_mode_trigger = null;
	rover.mission.package_delivered = null;
	rover.mission.current_mission_seq = 0;
	rover.motor.last_motor_speed_cmd = 0;
	rover.mission.auto_delivery = false;
	rover.mission.package_delivery_yaw = null;
	rover.mission.finished_package_yaw = null;

};


module.exports = reset_rover;