
var realsense_message_handler = function (rover, data) {

	try {
		rover.realsense.received_data = JSON.parse(data);
	}
	catch (e) {
		console.log('realsense_message_handler:', e)
	}

	console.log('realsense Message Handler received data: ', rover.realsense.received_data);

	rover.logs.realsense_message_handler.log(rover, 'Received data: ' + JSON.stringify(rover.realsense.received_data));

};

module.exports = realsense_message_handler;
