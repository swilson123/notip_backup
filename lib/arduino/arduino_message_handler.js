
var arduino_message_handler = function (rover, data) {

	try {
		rover.arduino.received_data = JSON.parse(data.replaceAll("'", '"'));
	}
	catch (e) {
		console.log('arduino_message_handler:', e)
	}

	//console.log('Arduino Message Handler received data: ', rover.arduino.received_data);

	if (rover.arduino.received_data.auto_delivery == 0 && rover.mission.auto_delivery) {
		//auto delivery off, package delivered
		console.log("Package Delivered! Return to dock");

		rover.mission.auto_delivery = false;
		rover.mission.package_delivered = true;
		//reverse mission sequence to go back to dock
		rover.mission.current_mission_seq -= 2;
	}

	rover.logs.arduino_message_handler.log(rover, 'Received data: ' + rover.arduino.received_data);

};

module.exports = arduino_message_handler;
