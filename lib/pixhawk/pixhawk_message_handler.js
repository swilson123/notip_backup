//sends message to radio and websocket........................
var pixhawk_message_handler = function (rover, message) {
	//console.log(message.name);
	if (message.name == 'HEARTBEAT') {
		//Make sure it's message is coming from autopilot not groundstation
		if (message.autopilot == 3) {
			rover.robot_data.HEARTBEAT = message;

			rover.logs.HEARTBEAT.log(rover, JSON.stringify(message));

			if (rover.flight_data.robot_flight_mode != rover.FlightModes[rover.robot_data.HEARTBEAT.custom_mode]) {
				rover.flight_data.robot_flight_mode = rover.FlightModes[rover.robot_data.HEARTBEAT.custom_mode];
				console.log('pixhawk_message_handler: flight_mode updated: ' + rover.flight_data.robot_flight_mode + ' Mode ID: ' + rover.robot_data.HEARTBEAT.custom_mode);

				rover.logs.pixhawk_message_handler.log(rover, 'flight_mode updated: ' + rover.flight_data.robot_flight_mode);

				if (rover.flight_data.robot_flight_mode == 'Guided' && rover.flight_mode_trigger == 'mission_finished') {
					rover.flight_mode_trigger = null;
					rover.deliver_package(rover, 'mission_item_reached');
				}
			}

			if (rover.flight_data.mav_state != rover.MavStates[rover.robot_data.HEARTBEAT.system_status]) {
				rover.update_mav_mode(rover, rover.robot_data.HEARTBEAT.system_status);

			}

			const MAV_MODE_FLAG_SAFETY_ARMED = 0x80;

			if ((message.base_mode & MAV_MODE_FLAG_SAFETY_ARMED) !== 0) {
				if (!rover.robot_data.is_armed) {
					rover.robot_data.is_armed = true;
					console.log("Vehicle is Armed");

					rover.reset_rover(rover);

					//request full mission.......
					var mav_response = rover.mavlink_messages.MISSION_REQUEST_LIST(rover);

					rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
				}
			} else if (rover.robot_data.is_armed) {
				rover.robot_data.is_armed = false;
				console.log("Vehicle is Disarmed");

			}

		}

	}
	else if (message.name == 'SYS_STATUS') {
		rover.robot_data.SYS_STATUS = message;
		rover.logs.SYS_STATUS.log(rover, JSON.stringify(message));

	}
	else if (message.name == 'STATUSTEXT') {
		rover.robot_data.STATUSTEXT = message;

		rover.logs.STATUSTEXT.log(rover, message);



	}
	else if (message.name == 'ATTITUDE') {
		rover.robot_data.ATTITUDE = message;
		rover.logs.ATTITUDE.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'VFR_HUD') {
		rover.robot_data.VFR_HUD = message;

		rover.logs.VFR_HUD.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'GLOBAL_POSITION_INT') {
		rover.robot_data.GLOBAL_POSITION_INT = message;
		rover.altitude.relative_alt_meters = rover.robot_data.GLOBAL_POSITION_INT.relative_alt / 1000;
		rover.altitude.msl_alt_meters = rover.robot_data.GLOBAL_POSITION_INT.alt / 1000;
		rover.robot_data.robot_latitude = parseFloat(rover.robot_data.GLOBAL_POSITION_INT.lat) / 10000000;
		rover.robot_data.robot_longitude = parseFloat(rover.robot_data.GLOBAL_POSITION_INT.lon) / 10000000;

		rover.logs.GLOBAL_POSITION_INT.log(rover, JSON.stringify(message));



	}
	else if (message.name == 'SERVO_OUTPUT_RAW') {
		//console.log('SERVO_OUTPUT_RAW Message Received', message);
		rover.robot_data.SERVO_OUTPUT_RAW = message;
		rover.logs.SERVO_OUTPUT_RAW.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'LOCAL_POSITION_NED') {
		rover.robot_data.LOCAL_POSITION_NED = message;
		rover.logs.LOCAL_POSITION_NED.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'ATTITUDE_QUATERNION') {
		rover.robot_data.ATTITUDE_QUATERNION = message;
		rover.logs.ATTITUDE_QUATERNION.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'HIGHRES_IMU') {
		rover.robot_data.HIGHRES_IMU = message;
		rover.logs.HIGHRES_IMU.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'GPS_RAW_INT') {
		rover.robot_data.GPS_RAW_INT = message;

		rover.logs.GPS_RAW_INT.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'PING') {
		rover.robot_data.PING = message;
		rover.logs.PING.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'SYSTEM_TIME') {
		rover.robot_data.SYSTEM_TIME = message;
		rover.logs.SYSTEM_TIME.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'MISSION_CURRENT') {
		//console.log('pixhawk_message_handler: MISSION_CURRENT - ', message);
		rover.robot_data.MISSION_CURRENT = message;
		rover.logs.MISSION_CURRENT.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'COMMAND_ACK') {
		rover.logs.COMMAND_ACK.log(rover, JSON.stringify(message));
		//console.log(message);

		rover.robot_data.COMMAND_ACK = message;

		if (message.command == 400) {
			if (message.result == 0) {
				console.log('Drone Disarmed - Reset Rover');


			}
			else {

				rover.logs.pixhawk_message_handler.log(rover, 'Failed to Disarm robot');

			}
		}

	}
	else if (message.name == 'PARAM_ACK') {
		console.log('pixhawk_message_handler: PARAM_ACK - ', message);

		rover.logs.PARAM_ACK.log(rover, JSON.stringify(message));
		rover.robot_data.PARAM_ACK = message;
	}
	else if (message.name == 'MISSION_ACK') {
		console.log('pixhawk_message_handler: MISSION_ACK - ', message);
		rover.logs.MISSION_ACK.log(rover, JSON.stringify(message));
		rover.robot_data.MISSION_ACK = message;

	}
	else if (message.name == 'MISSION_COUNT') {

		//download mission...............

		if (rover.mission.mission_count != message.count) {
			//console.log('pixhawk_message_handler: MISSION_COUNT - ', message.count);
			rover.logs.MISSION_COUNT.log(rover, JSON.stringify(message));

			rover.mission.mission_count = message.count;
			rover.download_mission(rover, rover.mission.mission_count);

		}

	}
	else if (message.name == 'MISSION_REQUEST') {
		console.log('pixhawk_message_handler: MISSION_REQUEST - ', message);
		rover.logs.MISSION_REQUEST.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'MISSION_ITEM_REACHED') {


		rover.logs.MISSION_ITEM_REACHED.log(rover, JSON.stringify(message));
		rover.mission_item_reached(rover, message);


	}
	else if (message.name == 'MISSION_ITEM') {
		//console.log('pixhawk_message_handler: MISSION_ITEM - ', message);
		rover.mission_item_array(rover, message);

	}
	else if (message.name == 'PARAM_VALUE') {
		rover.robot_data.PARAM_VALUE = message;
		rover.logs.PARAM_VALUE.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'RAW_IMU') {
		rover.logs.RAW_IMU.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_PRESSURE') {
		rover.logs.SCALED_PRESSURE.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'HWSTATUS') {
		rover.logs.HWSTATUS.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'AHRS') {
		rover.logs.AHRS.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'NAV_CONTROLLER_OUTPUT') {
		rover.logs.NAV_CONTROLLER_OUTPUT.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'MEMINFO') {
		rover.logs.MEMINFO.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'RC_CHANNELS_RAW') {
		rover.logs.RC_CHANNELS_RAW.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'SENSOR_OFFSETS') {
		rover.logs.SENSOR_OFFSETS.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'TERRAIN_REPORT') {
		rover.logs.TERRAIN_REPORT.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'TERRAIN_REQUEST') {
		rover.logs.TERRAIN_REQUEST.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'VIBRATION') {
		rover.logs.VIBRATION.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_IMU2') {
		rover.logs.SCALED_IMU2.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'TIMESYNC') {
		rover.logs.TIMESYNC.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'RC_CHANNELS') {
		rover.logs.RC_CHANNELS.log(rover, JSON.stringify(message));

		rover.radio_commands(rover, message);
	}
	else if (message.name == 'POWER_STATUS') {
		rover.logs.POWER_STATUS.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'BATTERY_STATUS') {
		rover.logs.BATTERY_STATUS.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'HOME_POSITION') {
		rover.logs.HOME_POSITION.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'GPS_GLOBAL_ORIGIN') {
		rover.logs.TERRAIN_REPORT.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'POSITION_TARGET_GLOBAL_INT') {
		rover.logs.POSITION_TARGET_GLOBAL_INT.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_PRESSURE2') {
		rover.logs.SCALED_PRESSURE2.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_IMU3') {
		rover.logs.SCALED_IMU3.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'RADIO_STATUS') {
		rover.logs.RADIO_STATUS.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'AUTOPILOT_VERSION') {
		rover.logs.AUTOPILOT_VERSION.log(rover, JSON.stringify(message));
	}
	else if (message.name == 'RANGEFINDER') {


		rover.robot_data.RANGEFINDER = message;
		rover.logs.RANGEFINDER.log(rover, JSON.stringify(message));


	}
	else if (message.name == 'DISTANCE_SENSOR') {
		rover.robot_data.DISTANCE_SENSOR = message;
		rover.logs.DISTANCE_SENSOR.log(rover, JSON.stringify(message));



	}
	else if (message.name == 'MANUAL_CONTROL') {
		console.log('MANUAL_CONTROL Message Received:', message);


	}
	else if (message.name == 'GPS_INPUT') {
		console.log(message);
	}
	else if (message.name == 'RC_CHANNELS_SCALED') {

	}
	else if (message.name == 'AHRS2') {

	}
	else if (message.name == 'EKF_STATUS_REPORT') {

	}
	else if (message.name == 'EXTENDED_SYS_STATE') {

	}
	else if (!message.name) {

	}
	else {
		console.log('pixhawk_message_handler: Unknown Mavlink Message - ' + message.name);
		rover.logs.pixhawk_message_handler.log(rover, 'Unknown Mavlink Message - ' + message.name);
	}


};


module.exports = pixhawk_message_handler;