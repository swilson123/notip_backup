//sends message to radio and websocket........................
var create_logs = function (rover) {
	//ROVER logs.............................................................
	rover.logs.server = new rover.logging(rover, 'server');
	rover.logs.rover_message_handler = new rover.logging(rover, 'rover_message_handler');
	rover.logs.send_message = new rover.logging(rover, 'send_message');
	rover.logs.serialports = new rover.logging(rover, 'serialports');
	rover.logs.send_pixhawk_command = new rover.logging(rover, 'send_pixhawk_command');
	rover.logs.pixhawk_message_handler = new rover.logging(rover, 'pixhawk_message_handler');
	rover.logs.update_mav_mode = new rover.logging(rover, 'update_mav_mode');
	rover.logs.connect_to_waveshare = new rover.logging(rover, 'connect_to_waveshare');
	rover.logs.arduino_message_handler = new rover.logging(rover, 'arduino_message_handler');
	//Pixhawk messages logs...................................................
	rover.logs.ATTITUDE = new rover.logging(rover, 'pixhawk/ATTITUDE');
	rover.logs.HEARTBEAT = new rover.logging(rover, 'pixhawk/HEARTBEAT');
	rover.logs.SYS_STATUS = new rover.logging(rover, 'pixhawk/SYS_STATUS');
	rover.logs.STATUSTEXT = new rover.logging(rover, 'pixhawk/STATUSTEXT');
	rover.logs.VFR_HUD = new rover.logging(rover, 'pixhawk/VFR_HUD');
	rover.logs.GLOBAL_POSITION_INT = new rover.logging(rover, 'pixhawk/GLOBAL_POSITION_INT');
	rover.logs.SERVO_OUTPUT_RAW = new rover.logging(rover, 'pixhawk/SERVO_OUTPUT_RAW');
	rover.logs.LOCAL_POSITION_NED = new rover.logging(rover, 'pixhawk/LOCAL_POSITION_NED');
	rover.logs.ATTITUDE_QUATERNION = new rover.logging(rover, 'pixhawk/ATTITUDE_QUATERNION');
	rover.logs.HIGHRES_IMU = new rover.logging(rover, 'pixhawk/HIGHRES_IMU');
	rover.logs.GPS_RAW_INT = new rover.logging(rover, 'pixhawk/GPS_RAW_INT');
	rover.logs.PING = new rover.logging(rover, 'pixhawk/PING');
	rover.logs.SYSTEM_TIME = new rover.logging(rover, 'pixhawk/SYSTEM_TIME');
	rover.logs.RANGEFINDER = new rover.logging(rover, 'pixhawk/RANGEFINDER');
	rover.logs.MISSION_CURRENT = new rover.logging(rover, 'pixhawk/MISSION_CURRENT');
	rover.logs.COMMAND_ACK = new rover.logging(rover, 'pixhawk/COMMAND_ACK');
	rover.logs.PARAM_ACK = new rover.logging(rover, 'pixhawk/PARAM_ACK');
	rover.logs.MISSION_ACK = new rover.logging(rover, 'pixhawk/MISSION_ACK');
	rover.logs.MISSION_COUNT = new rover.logging(rover, 'pixhawk/MISSION_COUNT');
	rover.logs.MISSION_REQUEST = new rover.logging(rover, 'pixhawk/MISSION_REQUEST');
	rover.logs.MISSION_ITEM_REACHED = new rover.logging(rover, 'pixhawk/MISSION_ITEM_REACHED');
	rover.logs.PARAM_VALUE = new rover.logging(rover, 'pixhawk/PARAM_VALUE');
	rover.logs.TERRAIN_REPORT = new rover.logging(rover, 'pixhawk/TERRAIN_REPORT');
	rover.logs.RAW_IMU = new rover.logging(rover, 'pixhawk/RAW_IMU');
	rover.logs.SCALED_PRESSURE = new rover.logging(rover, 'pixhawk/SCALED_PRESSURE');
	rover.logs.HWSTATUS = new rover.logging(rover, 'pixhawk/HWSTATUS');
	rover.logs.AHRS = new rover.logging(rover, 'pixhawk/AHRS');
	rover.logs.NAV_CONTROLLER_OUTPUT = new rover.logging(rover, 'pixhawk/NAV_CONTROLLER_OUTPUT');
	rover.logs.MEMINFO = new rover.logging(rover, 'pixhawk/MEMINFO');
	rover.logs.RC_CHANNELS_RAW = new rover.logging(rover, 'pixhawk/RC_CHANNELS_RAW');
	rover.logs.SENSOR_OFFSETS = new rover.logging(rover, 'pixhawk/SENSOR_OFFSETS');
	rover.logs.TERRAIN_REQUEST = new rover.logging(rover, 'pixhawk/TERRAIN_REQUEST');
	rover.logs.VIBRATION = new rover.logging(rover, 'pixhawk/VIBRATION');
	rover.logs.SCALED_IMU2 = new rover.logging(rover, 'pixhawk/SCALED_IMU2');
	rover.logs.TIMESYNC = new rover.logging(rover, 'pixhawk/TIMESYNC');
	rover.logs.RC_CHANNELS = new rover.logging(rover, 'pixhawk/RC_CHANNELS');
	rover.logs.POWER_STATUS = new rover.logging(rover, 'pixhawk/POWER_STATUS');
	rover.logs.BATTERY_STATUS = new rover.logging(rover, 'pixhawk/BATTERY_STATUS');
	rover.logs.HOME_POSITION = new rover.logging(rover, 'pixhawk/HOME_POSITION');
	rover.logs.GPS_GLOBAL_ORIGIN = new rover.logging(rover, 'pixhawk/GPS_GLOBAL_ORIGIN');
	rover.logs.DISTANCE_SENSOR = new rover.logging(rover, 'pixhawk/DISTANCE_SENSOR');
	rover.logs.SCALED_PRESSURE2 = new rover.logging(rover, 'pixhawk/SCALED_PRESSURE2');
	rover.logs.SCALED_IMU3 = new rover.logging(rover, 'pixhawk/SCALED_IMU3');
	rover.logs.POSITION_TARGET_GLOBAL_INT = new rover.logging(rover, 'pixhawk/POSITION_TARGET_GLOBAL_INT');
	rover.logs.RADIO_STATUS = new rover.logging(rover, 'pixhawk/RADIO_STATUS');
	rover.logs.AUTOPILOT_VERSION = new rover.logging(rover, 'pixhawk/AUTOPILOT_VERSION');


	rover.logs.server.log(rover, 'Hostname - ' + rover.hostname);
	rover.logs.server.log(rover, 'SITL - ' + rover.sitl.on);



	//Connect on load.........................................................
	setInterval(function () {

		//connect to devices.......................
		rover.connect_to_devices(rover);
		

	}, 5000);




};


module.exports = create_logs;