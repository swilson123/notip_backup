var mission_item_array = function (white_rabbit, message) {

	//MISSION_ITEM_INT: lat/lon are int 1e-7 deg - full RTK precision
	white_rabbit.mission.waypoints.push({
		seq: message.seq,
		lat: message.x / 10000000,
		lng: message.y / 10000000,
		reached: false
	});

	if (message.seq == white_rabbit.mission.mission_count - 1) {
		console.log("mission_item_array: Waypoints downloaded: ", white_rabbit.mission.waypoints);

		//Item 0 is home - say only the real waypoints
		var waypoint_count = white_rabbit.mission.mission_count - 1;
		if (white_rabbit.voice) white_rabbit.voice.say('Mission received. ' + waypoint_count + (waypoint_count == 1 ? ' waypoint.' : ' waypoints.'));

	}


};


module.exports = mission_item_array;