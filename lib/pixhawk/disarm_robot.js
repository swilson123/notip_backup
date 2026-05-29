//sends message to radio and websocket........................
var disarm_robot = function(white_rabbit, force_send)
	{
		var data = {
			param1: 0,
			param2: 0,
			param3: 0,
			param4: 0,
			param5: 0,
			param6: 0,
			param7: 0
		};

		var mav_response = white_rabbit.mavlink_messages.MAV_CMD_COMPONENT_ARM_DISARM(white_rabbit, data);
		//Tested Result: MISSION_ACK type: 0
		white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], force_send);

		white_rabbit.logs.white_rabbit_message_handler.log(white_rabbit, 'Disarm Commnand Sent');
		console.log('Disarming robot: look for command_ack response!');

	};


module.exports = disarm_robot;