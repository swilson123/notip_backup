//sends message to radio and websocket........................

// Last raw GPS sample — survives across message deliveries. Position itself is used
// RAW from the Pixhawk; these just provide the reference for jitter/outlier tracking.
// Max jump 5 m flags multi-path spikes for the jitter diagnostic.
let _gps_lat_ema      = null;
let _gps_lng_ema      = null;
const GPS_MAX_JUMP_M  = 5.0;

// GPS jitter tracking — EMA of successive raw-position jumps and reject streak.
// Published to white_rabbit.robot_data so sensor_coherence can diagnose which
// sensor is lying when GPS bearing and compass disagree.
let _gps_jitter_ema    = 0;      // metres — EMA of consecutive raw-position deltas
let _gps_reject_streak = 0;      // how many consecutive readings were outlier-rejected
const GPS_JITTER_ALPHA = 0.30;   // fast enough to catch a bad patch within ~3 readings
// Threshold for GPS being considered noisy enough to warrant compass-constrained correction.
const GPS_JITTER_NOISY_M = 1.5;

var pixhawk_message_handler = function (white_rabbit, message) {
	//console.log(message.name);
	if (message.name == 'HEARTBEAT') {
		//Make sure it's message is coming from autopilot not groundstation
		if (message.autopilot == 3) {
			white_rabbit.robot_data.HEARTBEAT = message;

			white_rabbit.logs.HEARTBEAT.log(white_rabbit, JSON.stringify(message));

			if (white_rabbit.flight_data.robot_flight_mode != white_rabbit.FlightModes[white_rabbit.robot_data.HEARTBEAT.custom_mode]) {
				white_rabbit.flight_data.robot_flight_mode = white_rabbit.FlightModes[white_rabbit.robot_data.HEARTBEAT.custom_mode];
				console.log('pixhawk_message_handler: flight_mode updated: ' + white_rabbit.flight_data.robot_flight_mode + ' Mode ID: ' + white_rabbit.robot_data.HEARTBEAT.custom_mode);

				white_rabbit.logs.pixhawk_message_handler.log(white_rabbit, 'flight_mode updated: ' + white_rabbit.flight_data.robot_flight_mode);

				if (white_rabbit.flight_data.robot_flight_mode == 'Guided' && white_rabbit.flight_mode_trigger == 'mission_finished') {
					white_rabbit.flight_mode_trigger = null;
					white_rabbit.deliver_package(white_rabbit, 'mission_item_reached');
				}
			}

			if (white_rabbit.flight_data.mav_state != white_rabbit.MavStates[white_rabbit.robot_data.HEARTBEAT.system_status]) {
				white_rabbit.update_mav_mode(white_rabbit, white_rabbit.robot_data.HEARTBEAT.system_status);

			}

			const MAV_MODE_FLAG_SAFETY_ARMED = 0x80;

			if ((message.base_mode & MAV_MODE_FLAG_SAFETY_ARMED) !== 0) {
				if (!white_rabbit.robot_data.is_armed) {
					white_rabbit.robot_data.is_armed = true;
					console.log("Vehicle is Armed");

					white_rabbit.reset_white_rabbit(white_rabbit);

					//request full mission.......
					var mav_response = white_rabbit.mavlink_messages.MISSION_REQUEST_LIST(white_rabbit);

					white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], null);
				}
			} else if (white_rabbit.robot_data.is_armed) {
				white_rabbit.robot_data.is_armed = false;
				console.log("Vehicle is Disarmed");

			}

		}

	}
	else if (message.name == 'SYS_STATUS') {
		white_rabbit.robot_data.SYS_STATUS = message;
		white_rabbit.robot_data.sys_status_ts = Date.now();
		white_rabbit.logs.SYS_STATUS.log(white_rabbit, JSON.stringify(message));

	}
	else if (message.name == 'STATUSTEXT') {
		white_rabbit.robot_data.STATUSTEXT = message;

		white_rabbit.logs.STATUSTEXT.log(white_rabbit, message);



	}
	else if (message.name == 'ATTITUDE') {
		white_rabbit.robot_data.ATTITUDE = message;
		white_rabbit.robot_data.attitude_ts = Date.now();
		white_rabbit.logs.ATTITUDE.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'VFR_HUD') {
		white_rabbit.robot_data.VFR_HUD = message;
		white_rabbit.robot_data.vfr_hud_ts = Date.now();
		white_rabbit.logs.VFR_HUD.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'GLOBAL_POSITION_INT') {
		white_rabbit.robot_data.GLOBAL_POSITION_INT = message;
		white_rabbit.altitude.relative_alt_meters = white_rabbit.robot_data.GLOBAL_POSITION_INT.relative_alt / 1000;
		white_rabbit.altitude.msl_alt_meters = white_rabbit.robot_data.GLOBAL_POSITION_INT.alt / 1000;

		let raw_lat = parseFloat(message.lat) / 10000000;
		let raw_lng = parseFloat(message.lon) / 10000000;

		if (raw_lat && raw_lng) {
			// Position is used RAW from the Pixhawk (GLOBAL_POSITION_INT is already the
			// Pixhawk EKF's fused solution) — no extra EMA, no compass projection.
			// The block below only tracks jitter/outlier diagnostics from consecutive
			// raw samples so sensor_coherence can still report GPS quality.
			if (_gps_lat_ema !== null) {
				let jump_m = white_rabbit.gps_distance(_gps_lat_ema, _gps_lng_ema, raw_lat, raw_lng) * 1000;
				if (jump_m < GPS_MAX_JUMP_M) {
					_gps_jitter_ema    = _gps_jitter_ema * (1 - GPS_JITTER_ALPHA) + jump_m * GPS_JITTER_ALPHA;
					_gps_reject_streak = 0;
				} else {
					_gps_reject_streak++;
				}
			}
			// _gps_lat_ema/_gps_lng_ema now just hold the last raw sample (jitter reference).
			_gps_lat_ema = raw_lat;
			_gps_lng_ema = raw_lng;

			white_rabbit.robot_data.robot_latitude    = raw_lat;
			white_rabbit.robot_data.robot_longitude   = raw_lng;
			white_rabbit.robot_data.gps_jitter_m      = _gps_jitter_ema;
			white_rabbit.robot_data.gps_reject_streak = _gps_reject_streak;
			white_rabbit.robot_data.position_ts       = Date.now();
		}

		white_rabbit.logs.GLOBAL_POSITION_INT.log(white_rabbit, JSON.stringify(message));



	}
	else if (message.name == 'SERVO_OUTPUT_RAW') {
		//console.log('SERVO_OUTPUT_RAW Message Received', message);
		white_rabbit.robot_data.SERVO_OUTPUT_RAW = message;
		white_rabbit.logs.SERVO_OUTPUT_RAW.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'LOCAL_POSITION_NED') {
		white_rabbit.robot_data.LOCAL_POSITION_NED = message;
		white_rabbit.logs.LOCAL_POSITION_NED.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'ATTITUDE_QUATERNION') {
		white_rabbit.robot_data.ATTITUDE_QUATERNION = message;
		white_rabbit.logs.ATTITUDE_QUATERNION.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'HIGHRES_IMU') {
		white_rabbit.robot_data.HIGHRES_IMU = message;
		white_rabbit.logs.HIGHRES_IMU.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'GPS_RAW_INT') {
		white_rabbit.robot_data.GPS_RAW_INT = message;

		white_rabbit.logs.GPS_RAW_INT.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'PING') {
		white_rabbit.robot_data.PING = message;
		white_rabbit.logs.PING.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'SYSTEM_TIME') {
		white_rabbit.robot_data.SYSTEM_TIME = message;
		white_rabbit.logs.SYSTEM_TIME.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'MISSION_CURRENT') {
		//console.log('pixhawk_message_handler: MISSION_CURRENT - ', message);
		white_rabbit.robot_data.MISSION_CURRENT = message;
		white_rabbit.logs.MISSION_CURRENT.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'COMMAND_ACK') {
		white_rabbit.logs.COMMAND_ACK.log(white_rabbit, JSON.stringify(message));
		//console.log(message);

		white_rabbit.robot_data.COMMAND_ACK = message;

		if (message.command == 400) {
			if (message.result == 0) {
				console.log('Drone Disarmed - Reset White_rabbit');


			}
			else {

				white_rabbit.logs.pixhawk_message_handler.log(white_rabbit, 'Failed to Disarm robot');

			}
		}

	}
	else if (message.name == 'PARAM_ACK') {
		console.log('pixhawk_message_handler: PARAM_ACK - ', message);

		white_rabbit.logs.PARAM_ACK.log(white_rabbit, JSON.stringify(message));
		white_rabbit.robot_data.PARAM_ACK = message;
	}
	else if (message.name == 'MISSION_ACK') {
		console.log('pixhawk_message_handler: MISSION_ACK - ', message);
		white_rabbit.logs.MISSION_ACK.log(white_rabbit, JSON.stringify(message));
		white_rabbit.robot_data.MISSION_ACK = message;

	}
	else if (message.name == 'MISSION_COUNT') {

		//download mission...............

		if (white_rabbit.mission.mission_count != message.count) {
			//console.log('pixhawk_message_handler: MISSION_COUNT - ', message.count);
			white_rabbit.logs.MISSION_COUNT.log(white_rabbit, JSON.stringify(message));

			white_rabbit.mission.mission_count = message.count;
			white_rabbit.mission._mission_received_announced = false;  // arm the "Mission received" voice for this download
			white_rabbit.download_mission(white_rabbit, white_rabbit.mission.mission_count);

		}

	}
	else if (message.name == 'MISSION_REQUEST') {
		console.log('pixhawk_message_handler: MISSION_REQUEST - ', message);
		white_rabbit.logs.MISSION_REQUEST.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'MISSION_ITEM_REACHED') {


		white_rabbit.logs.MISSION_ITEM_REACHED.log(white_rabbit, JSON.stringify(message));
		white_rabbit.mission_item_reached(white_rabbit, message);


	}
	else if (message.name == 'MISSION_ITEM') {
		//console.log('pixhawk_message_handler: MISSION_ITEM - ', message);
		white_rabbit.mission_item_array(white_rabbit, message);

	}
	else if (message.name == 'PARAM_VALUE') {
		white_rabbit.robot_data.PARAM_VALUE = message;
		white_rabbit.logs.PARAM_VALUE.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'RAW_IMU') {
		white_rabbit.logs.RAW_IMU.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_PRESSURE') {
		white_rabbit.logs.SCALED_PRESSURE.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'HWSTATUS') {
		white_rabbit.logs.HWSTATUS.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'AHRS') {
		white_rabbit.logs.AHRS.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'NAV_CONTROLLER_OUTPUT') {
		white_rabbit.logs.NAV_CONTROLLER_OUTPUT.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'MEMINFO') {
		white_rabbit.logs.MEMINFO.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'RC_CHANNELS_RAW') {
		white_rabbit.logs.RC_CHANNELS_RAW.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'SENSOR_OFFSETS') {
		white_rabbit.logs.SENSOR_OFFSETS.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'TERRAIN_REPORT') {
		white_rabbit.logs.TERRAIN_REPORT.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'TERRAIN_REQUEST') {
		white_rabbit.logs.TERRAIN_REQUEST.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'VIBRATION') {
		white_rabbit.logs.VIBRATION.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_IMU2') {
		white_rabbit.logs.SCALED_IMU2.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'TIMESYNC') {
		white_rabbit.logs.TIMESYNC.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'RC_CHANNELS') {
		white_rabbit.logs.RC_CHANNELS.log(white_rabbit, JSON.stringify(message));

		white_rabbit.radio_commands(white_rabbit, message);
	}
	else if (message.name == 'POWER_STATUS') {
		white_rabbit.logs.POWER_STATUS.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'BATTERY_STATUS') {
		white_rabbit.logs.BATTERY_STATUS.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'HOME_POSITION') {
		white_rabbit.logs.HOME_POSITION.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'GPS_GLOBAL_ORIGIN') {
		white_rabbit.logs.TERRAIN_REPORT.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'POSITION_TARGET_GLOBAL_INT') {
		white_rabbit.logs.POSITION_TARGET_GLOBAL_INT.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_PRESSURE2') {
		white_rabbit.logs.SCALED_PRESSURE2.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'SCALED_IMU3') {
		white_rabbit.logs.SCALED_IMU3.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'RADIO_STATUS') {
		white_rabbit.logs.RADIO_STATUS.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'AUTOPILOT_VERSION') {
		white_rabbit.logs.AUTOPILOT_VERSION.log(white_rabbit, JSON.stringify(message));
	}
	else if (message.name == 'RANGEFINDER') {


		white_rabbit.robot_data.RANGEFINDER = message;
		white_rabbit.logs.RANGEFINDER.log(white_rabbit, JSON.stringify(message));


	}
	else if (message.name == 'DISTANCE_SENSOR') {
		white_rabbit.robot_data.DISTANCE_SENSOR = message;
		white_rabbit.logs.DISTANCE_SENSOR.log(white_rabbit, JSON.stringify(message));



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
		white_rabbit.logs.pixhawk_message_handler.log(white_rabbit, 'Unknown Mavlink Message - ' + message.name);
	}


};


module.exports = pixhawk_message_handler;