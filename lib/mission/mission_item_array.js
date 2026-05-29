var mission_item_array = function (white_rabbit, message) {

	white_rabbit.mission.waypoints.push({
		seq: message.seq,
		lat: message.x,
		lng: message.y,
		reached: false
	});

	if (message.seq == white_rabbit.mission.mission_count - 1) {
		console.log("mission_item_array: Waypoints downloaded: ", white_rabbit.mission.waypoints);


	}


};


module.exports = mission_item_array;