var create_realsense_message = function (rover, message, value) {

//Available commands to send to realsense
//Commands: deliver_package, belt, arm

	if (rover.realsense.process && rover.realsense.process.stdin && !rover.realsense.process.stdin.destroyed) {
		try {
			console.log('Sending to realsense vision process: ', message + ' with value: ' + value);
			rover.logs.realsense_message_handler.log(rover, 'Sending to realsense vision process: ' + message);
			rover.realsense.process.stdin.write('{' + '"message": ' + '"' + message + '", "value": "' + value + '"}\n');
		} catch (e) {
			console.log(e);
			rover.logs.realsense_message_handler.log(rover, 'Error writing to realsense vision process: ' + e.toString());
		}

	} else if (rover.realsense.serial) {
		try {
			console.log('Sending to realsense: ', message + ' with value: ' + value);
			rover.logs.realsense_message_handler.log(rover, 'Sending to realsense: ' + message);
			rover.realsense.serial.write('{"message": "' + message + '", "value": "' + value + '"}\n');
		} catch (e) {
			console.log(e);
			rover.logs.realsense_message_handler.error('Error writing to realsense port: ', e);
		}

	} else {
		console.log('realsense Port not connected! Message failed to send:', message);
	}
};

module.exports = create_realsense_message;
