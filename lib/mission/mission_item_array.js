var mission_item_array = function (white_rabbit, message) {

	white_rabbit.mission.waypoints.push({
		seq: message.seq,
		lat: message.x,
		lng: message.y,
		reached: false
	});

	if (message.seq == white_rabbit.mission.mission_count - 1) {
		console.log("mission_item_array: Waypoints downloaded: ", white_rabbit.mission.waypoints);

		// Full mission downloaded from the Pixhawk — announce once per download
		// (the flag is reset when a new MISSION_COUNT starts the next download).
		if (!white_rabbit.mission._mission_received_announced) {
			white_rabbit.mission._mission_received_announced = true;
			if (white_rabbit.voice) white_rabbit.voice.say('Mission received.');
		}
	}


};


module.exports = mission_item_array;