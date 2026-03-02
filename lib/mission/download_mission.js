//Download Mission
var download_mission = function (rover, count) {

	console.log('download_mission: Count ', count);

	for (var i = 0; i < count; i++) {
		var data = {
			seq: i,
		};

		var mav_response = rover.mavlink_messages.MISSION_REQUEST(rover, data);

		rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);
	}
};


module.exports = download_mission;