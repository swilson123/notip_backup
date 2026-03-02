//sends message to radio and websocket........................
var set_flight_mode = function(rover, mode)
	{

		if (rover.flight_data.robot_flight_mode != 'Guided' && mode == 'Guided')
		{

			//Switch flightmode to guided mode...................................
			if (rover.mav_version == 1)
			{
				var data = {
					param1: 0,
					param2: 217,
					param3: 15,
				};

				var mav_response = rover.mavlink_messages.SET_MODE(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}
			else if (rover.mav_version == 2)
			{
				var data = {
					status_text: 'MAV_CMD_DO_SET_MODE: Guided',
					command: rover.mavlink.MAV_CMD_DO_SET_MODE,
					confirmation: 1,
					param1: 217,
					param2: 15,
					param3: 0,
					param4: 0,
					param5: 0,
					param6: 0,
					param6: 0
				};

				var mav_response = rover.mavlink_messages.COMMAND_LONG(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}


		}
		else if (rover.flight_data.robot_flight_mode != 'Manual' && mode == 'Manual')
		{

			if (rover.mav_version == 1)
			{
				//Switch flightmode to stabilize...................................
				var data = {
					param1: 0,
					param2: 81,
					param3: 0,
				};

				var mav_response = rover.mavlink_messages.SET_MODE(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}
			else if (rover.mav_version == 2)
			{

				var data = {
					status_text: 'MAV_CMD_DO_SET_MODE: Manual',
					command: rover.mavlink.MAV_CMD_DO_SET_MODE,
					confirmation: 1,
					param1: 81,
					param2: 0,
					param3: 0,
					param4: 0,
					param5: 0,
					param6: 0,
					param6: 0
				};

				var mav_response = rover.mavlink_messages.COMMAND_LONG(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}



		}
		else if (rover.flight_data.robot_flight_mode != 'Auto' && mode == 'Auto')
		{

			//Switch flightmode to Auto mode...................................
			if (rover.mav_version == 1)
			{
				var data = {
					param1: 0,
					param2: 217,
					param3: 10,
				};

				var mav_response = rover.mavlink_messages.SET_MODE(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}
			else if (rover.mav_version == 2)
			{
				var data = {
					status_text: 'MAV_CMD_DO_SET_MODE: AUTO',
					command: rover.mavlink.MAV_CMD_DO_SET_MODE,
					confirmation: 1,
					param1: 217,
					param2: 10,
					param3: 0,
					param4: 0,
					param5: 0,
					param6: 0,
					param6: 0
				};

				var mav_response = rover.mavlink_messages.COMMAND_LONG(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}


		}
		else if (rover.flight_data.robot_flight_mode != 'Loiter' && mode == 'Loiter')
		{

			//Switch flightmode to Auto mode...................................
			if (rover.mav_version == 1)
			{
				var data = {
					param1: 0,
					param2: 217,
					param3: 5,
				};

				var mav_response = rover.mavlink_messages.SET_MODE(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}
			else if (rover.mav_version == 2)
			{
				var data = {
					status_text: 'MAV_CMD_DO_SET_MODE: Loiter',
					command: rover.mavlink.MAV_CMD_DO_SET_MODE,
					confirmation: 1,
					param1: 217,
					param2: 5,
					param3: 0,
					param4: 0,
					param5: 0,
					param6: 0,
					param6: 0
				};

				var mav_response = rover.mavlink_messages.COMMAND_LONG(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}


		}
		else if (rover.flight_data.robot_flight_mode != 'SMART_RTL' && mode == 'SMART_RTL')
		{
console.log('Change Flight Mode to: Smart RTL');
			//Switch flightmode to Auto mode...................................
			if (rover.mav_version == 1)
			{
				var data = {
					param1: 0,
					param2: 217,
					param3: 12,
				};

				var mav_response = rover.mavlink_messages.SET_MODE(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}
			else if (rover.mav_version == 2)
			{
				var data = {
					status_text: 'MAV_CMD_DO_SET_MODE: SMART_RTL',
					command: rover.mavlink.MAV_CMD_DO_SET_MODE,
					confirmation: 1,
					param1: 217,
					param2: 12,
					param3: 0,
					param4: 0,
					param5: 0,
					param6: 0,
					param6: 0
				};

				var mav_response = rover.mavlink_messages.COMMAND_LONG(rover, data);
				rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
			}


		}


	};


module.exports = set_flight_mode;