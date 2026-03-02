//sends message to radio and websocket........................
var disarm_robot = function(rover, force_send)
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

		var mav_response = rover.mavlink_messages.MAV_CMD_COMPONENT_ARM_DISARM(rover, data);
		//Tested Result: MISSION_ACK type: 0
		rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], force_send);

		rover.logs.rover_message_handler.log(rover, 'Disarm Commnand Sent');
		console.log('Disarming robot: look for command_ack response!');

	};


module.exports = disarm_robot;