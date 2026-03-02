var mission_item_array = function (rover, message) {

	rover.mission.waypoints.push({
		seq: message.seq,
		lat: message.x,
		lng: message.y,
		reached: false
	});

	if (message.seq == rover.mission.mission_count - 1) {
		console.log("mission_item_array: Waypoints downloaded: ", rover.mission.waypoints);


	}


};


module.exports = mission_item_array;