//sends message to radio and websocket........................
var request_data_stream = function (rover, force_send) {

	console.log('request_data_stream');
	//MAV_CMD_REQUEST_AUTOPILOT_CAPABILITIES................
	var data = {
		status_text: 'MAV_CMD_REQUEST_AUTOPILOT_CAPABILITIES',
		command: rover.mavlink.MAV_CMD_REQUEST_AUTOPILOT_CAPABILITIES,
		confirmation: 1,
		param1: 1,
		param2: 0,
		param3: 0,
		param4: 0,
		param5: 0,
		param6: 0,
		param6: 0
	};

	var mav_response = rover.mavlink_messages.COMMAND_LONG(rover, data);
	rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);



	//Data stream all................
	var data = {
		req_stream_id: rover.mavlink.MAV_DATA_STREAM_ALL,
		req_message_rate: 1,
		start_stop: 1
	};

	var mav_response = rover.mavlink_messages.REQUEST_DATA_STREAM(rover, data);
	rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], true);


	setTimeout(function () {
		//Drone Heading data speed...........
		var data = {
			req_stream_id: rover.mavlink.MAV_DATA_STREAM_EXTRA2,
			req_message_rate: 5,
			start_stop: 1
		};

		var mav_response = rover.mavlink_messages.REQUEST_DATA_STREAM(rover, data);
		rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], true);
	}, 1000);

	setTimeout(function () {
		//Rangefinder data speed...........
		var data = {
			req_stream_id: rover.mavlink.MAV_DATA_STREAM_EXTRA3,
			req_message_rate: 10,
			start_stop: 1
		};

		var mav_response = rover.mavlink_messages.REQUEST_DATA_STREAM(rover, data);
		rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], true);

	}, 2000);


};


module.exports = request_data_stream;