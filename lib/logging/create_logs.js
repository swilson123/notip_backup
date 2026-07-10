//sends message to radio and websocket........................
var create_logs = function (white_rabbit) {
	//ROVER logs.............................................................
	white_rabbit.logs.server = new white_rabbit.logging(white_rabbit, 'server');
	white_rabbit.logs.white_rabbit_message_handler = new white_rabbit.logging(white_rabbit, 'white_rabbit_message_handler');
	white_rabbit.logs.send_message = new white_rabbit.logging(white_rabbit, 'send_message');
	white_rabbit.logs.serialports = new white_rabbit.logging(white_rabbit, 'serialports');
	white_rabbit.logs.send_pixhawk_command = new white_rabbit.logging(white_rabbit, 'send_pixhawk_command');
	white_rabbit.logs.pixhawk_message_handler = new white_rabbit.logging(white_rabbit, 'pixhawk_message_handler');
	white_rabbit.logs.update_mav_mode = new white_rabbit.logging(white_rabbit, 'update_mav_mode');
	white_rabbit.logs.connect_to_waveshare = new white_rabbit.logging(white_rabbit, 'connect_to_waveshare');
	white_rabbit.logs.waveshare_message_handler = new white_rabbit.logging(white_rabbit, 'waveshare_message_handler');
	white_rabbit.logs.arduino_message_handler = new white_rabbit.logging(white_rabbit, 'arduino_message_handler');
	white_rabbit.logs.ldr_message_handler = new white_rabbit.logging(white_rabbit, 'ldr_message_handler');
	white_rabbit.logs.realsense_message_handler = new white_rabbit.logging(white_rabbit, 'realsense_message_handler');
	white_rabbit.logs.sidewalk_detection = new white_rabbit.logging(white_rabbit, 'sidewalk_detection');
	white_rabbit.logs.run_mission = new white_rabbit.logging(white_rabbit, 'run_mission');
	white_rabbit.logs.intelligence = new white_rabbit.logging(white_rabbit, 'intelligence');
	white_rabbit.logs.avoid_object = new white_rabbit.logging(white_rabbit, 'avoid_object');
	white_rabbit.logs.lidar_message_filter = new white_rabbit.logging(white_rabbit, 'lidar_message_filter');
	white_rabbit.logs.imu = new white_rabbit.logging(white_rabbit, 'imu');
	white_rabbit.logs.irlock = new white_rabbit.logging(white_rabbit, 'irlock');
	white_rabbit.logs.follow_the_yelow_bick_road = new white_rabbit.logging(white_rabbit, 'follow_the_yelow_bick_road');
	//Pixhawk messages logs...................................................
	white_rabbit.logs.ATTITUDE = new white_rabbit.logging(white_rabbit, 'pixhawk/ATTITUDE');
	white_rabbit.logs.HEARTBEAT = new white_rabbit.logging(white_rabbit, 'pixhawk/HEARTBEAT');
	white_rabbit.logs.SYS_STATUS = new white_rabbit.logging(white_rabbit, 'pixhawk/SYS_STATUS');
	white_rabbit.logs.STATUSTEXT = new white_rabbit.logging(white_rabbit, 'pixhawk/STATUSTEXT');
	white_rabbit.logs.VFR_HUD = new white_rabbit.logging(white_rabbit, 'pixhawk/VFR_HUD');
	white_rabbit.logs.GLOBAL_POSITION_INT = new white_rabbit.logging(white_rabbit, 'pixhawk/GLOBAL_POSITION_INT');
	white_rabbit.logs.SERVO_OUTPUT_RAW = new white_rabbit.logging(white_rabbit, 'pixhawk/SERVO_OUTPUT_RAW');
	white_rabbit.logs.LOCAL_POSITION_NED = new white_rabbit.logging(white_rabbit, 'pixhawk/LOCAL_POSITION_NED');
	white_rabbit.logs.ATTITUDE_QUATERNION = new white_rabbit.logging(white_rabbit, 'pixhawk/ATTITUDE_QUATERNION');
	white_rabbit.logs.HIGHRES_IMU = new white_rabbit.logging(white_rabbit, 'pixhawk/HIGHRES_IMU');
	white_rabbit.logs.GPS_RAW_INT = new white_rabbit.logging(white_rabbit, 'pixhawk/GPS_RAW_INT');
	white_rabbit.logs.PING = new white_rabbit.logging(white_rabbit, 'pixhawk/PING');
	white_rabbit.logs.SYSTEM_TIME = new white_rabbit.logging(white_rabbit, 'pixhawk/SYSTEM_TIME');
	white_rabbit.logs.RANGEFINDER = new white_rabbit.logging(white_rabbit, 'pixhawk/RANGEFINDER');
	white_rabbit.logs.MISSION_CURRENT = new white_rabbit.logging(white_rabbit, 'pixhawk/MISSION_CURRENT');
	white_rabbit.logs.COMMAND_ACK = new white_rabbit.logging(white_rabbit, 'pixhawk/COMMAND_ACK');
	white_rabbit.logs.PARAM_ACK = new white_rabbit.logging(white_rabbit, 'pixhawk/PARAM_ACK');
	white_rabbit.logs.MISSION_ACK = new white_rabbit.logging(white_rabbit, 'pixhawk/MISSION_ACK');
	white_rabbit.logs.MISSION_COUNT = new white_rabbit.logging(white_rabbit, 'pixhawk/MISSION_COUNT');
	white_rabbit.logs.MISSION_REQUEST = new white_rabbit.logging(white_rabbit, 'pixhawk/MISSION_REQUEST');
	white_rabbit.logs.MISSION_ITEM_REACHED = new white_rabbit.logging(white_rabbit, 'pixhawk/MISSION_ITEM_REACHED');
	white_rabbit.logs.PARAM_VALUE = new white_rabbit.logging(white_rabbit, 'pixhawk/PARAM_VALUE');
	white_rabbit.logs.TERRAIN_REPORT = new white_rabbit.logging(white_rabbit, 'pixhawk/TERRAIN_REPORT');
	white_rabbit.logs.RAW_IMU = new white_rabbit.logging(white_rabbit, 'pixhawk/RAW_IMU');
	white_rabbit.logs.SCALED_PRESSURE = new white_rabbit.logging(white_rabbit, 'pixhawk/SCALED_PRESSURE');
	white_rabbit.logs.HWSTATUS = new white_rabbit.logging(white_rabbit, 'pixhawk/HWSTATUS');
	white_rabbit.logs.AHRS = new white_rabbit.logging(white_rabbit, 'pixhawk/AHRS');
	white_rabbit.logs.NAV_CONTROLLER_OUTPUT = new white_rabbit.logging(white_rabbit, 'pixhawk/NAV_CONTROLLER_OUTPUT');
	white_rabbit.logs.MEMINFO = new white_rabbit.logging(white_rabbit, 'pixhawk/MEMINFO');
	white_rabbit.logs.RC_CHANNELS_RAW = new white_rabbit.logging(white_rabbit, 'pixhawk/RC_CHANNELS_RAW');
	white_rabbit.logs.SENSOR_OFFSETS = new white_rabbit.logging(white_rabbit, 'pixhawk/SENSOR_OFFSETS');
	white_rabbit.logs.TERRAIN_REQUEST = new white_rabbit.logging(white_rabbit, 'pixhawk/TERRAIN_REQUEST');
	white_rabbit.logs.VIBRATION = new white_rabbit.logging(white_rabbit, 'pixhawk/VIBRATION');
	white_rabbit.logs.SCALED_IMU2 = new white_rabbit.logging(white_rabbit, 'pixhawk/SCALED_IMU2');
	white_rabbit.logs.TIMESYNC = new white_rabbit.logging(white_rabbit, 'pixhawk/TIMESYNC');
	white_rabbit.logs.RC_CHANNELS = new white_rabbit.logging(white_rabbit, 'pixhawk/RC_CHANNELS');
	white_rabbit.logs.POWER_STATUS = new white_rabbit.logging(white_rabbit, 'pixhawk/POWER_STATUS');
	white_rabbit.logs.BATTERY_STATUS = new white_rabbit.logging(white_rabbit, 'pixhawk/BATTERY_STATUS');
	white_rabbit.logs.HOME_POSITION = new white_rabbit.logging(white_rabbit, 'pixhawk/HOME_POSITION');
	white_rabbit.logs.GPS_GLOBAL_ORIGIN = new white_rabbit.logging(white_rabbit, 'pixhawk/GPS_GLOBAL_ORIGIN');
	white_rabbit.logs.DISTANCE_SENSOR = new white_rabbit.logging(white_rabbit, 'pixhawk/DISTANCE_SENSOR');
	white_rabbit.logs.SCALED_PRESSURE2 = new white_rabbit.logging(white_rabbit, 'pixhawk/SCALED_PRESSURE2');
	white_rabbit.logs.SCALED_IMU3 = new white_rabbit.logging(white_rabbit, 'pixhawk/SCALED_IMU3');
	white_rabbit.logs.POSITION_TARGET_GLOBAL_INT = new white_rabbit.logging(white_rabbit, 'pixhawk/POSITION_TARGET_GLOBAL_INT');
	white_rabbit.logs.RADIO_STATUS = new white_rabbit.logging(white_rabbit, 'pixhawk/RADIO_STATUS');
	white_rabbit.logs.AUTOPILOT_VERSION = new white_rabbit.logging(white_rabbit, 'pixhawk/AUTOPILOT_VERSION');


	white_rabbit.logs.server.log(white_rabbit, 'Hostname - ' + white_rabbit.hostname);
	white_rabbit.logs.server.log(white_rabbit, 'SITL - ' + white_rabbit.sitl.on);



	//Connect on load.........................................................
	setInterval(function () {

		//connect to devices.......................
		white_rabbit.connect_to_devices(white_rabbit);
		

	}, 5000);




};


module.exports = create_logs;