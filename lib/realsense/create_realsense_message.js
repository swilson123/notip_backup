var create_realsense_message = function (white_rabbit, message, value) {

//Available commands to send to realsense
//Commands: deliver_package, belt, arm

	if (white_rabbit.realsense.process && white_rabbit.realsense.process.stdin && !white_rabbit.realsense.process.stdin.destroyed) {
		try {
			console.log('Sending to realsense vision process: ', message + ' with value: ' + value);
			white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Sending to realsense vision process: ' + message);
			white_rabbit.realsense.process.stdin.write('{' + '"message": ' + '"' + message + '", "value": "' + value + '"}\n');
		} catch (e) {
			console.log(e);
			white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Error writing to realsense vision process: ' + e.toString());
		}

	} else if (white_rabbit.realsense.serial) {
		try {
			console.log('Sending to realsense: ', message + ' with value: ' + value);
			white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Sending to realsense: ' + message);
			white_rabbit.realsense.serial.write('{"message": "' + message + '", "value": "' + value + '"}\n');
		} catch (e) {
			console.log(e);
			white_rabbit.logs.realsense_message_handler.error('Error writing to realsense port: ', e);
		}

	} else {
		console.log('realsense Port not connected! Message failed to send:', message);
	}
};

module.exports = create_realsense_message;
