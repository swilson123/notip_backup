
var arduino_message_handler = function (rover, data) {

	try {
		rover.arduino.received_data = JSON.parse(data.replaceAll("'", '"'));

		if (rover.arduino.received_data.auto_delivery == 0 && rover.mission.auto_delivery) {
			console.log("Package Delivered! Return to dock");
			rover.mission.auto_delivery = false;
			rover.mission.package_delivered = true;
			rover.mission.current_mission_seq -= 2;
			if (rover.learning && typeof rover.learning.add === 'function') {
				rover.learning.add('successful_delivery', {
					method: 'arduino',
					lat:    rover.robot_data && rover.robot_data.robot_latitude,
					lng:    rover.robot_data && rover.robot_data.robot_longitude
				});
			}
		}

		rover.logs.arduino_message_handler.log(rover, 'Received data: ' + JSON.stringify(rover.arduino.received_data));
	}
	catch (e) {
		// Silently drop malformed fragments — the brace accumulator in
		// connect_to_arduino.js prevents this in normal operation.
		rover.logs.arduino_message_handler.log(rover, 'parse error (fragment dropped): ' + data.slice(0, 40));
	}

};

module.exports = arduino_message_handler;
