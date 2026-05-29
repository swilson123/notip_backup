//Download Mission
var download_mission = function (white_rabbit, count) {

	console.log('download_mission: Count ', count);

	for (var i = 0; i < count; i++) {
		var data = {
			seq: i,
		};

		var mav_response = white_rabbit.mavlink_messages.MISSION_REQUEST(white_rabbit, data);

		white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], null);
	}
};


module.exports = download_mission;