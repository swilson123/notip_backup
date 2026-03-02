//sends message to radio and websocket........................
var mission_item_reached = function (rover, message) {
	console.log('MISSION_ITEM_REACHED - ', message.seq);
	rover.mission.last_reached_mission_seq = message.seq;
    rover.mission.current_mission_seq = message.seq + 1;


	//Update waypoint array
	for (var i = 0; i < rover.mission.waypoints.length; i++) {
		if (rover.mission.waypoints[i].seq == message.seq) {
			rover.mission.waypoints[i].reached = true;
		}
	}

	if (rover.mission.mission_count == rover.mission.current_mission_seq) {
		//Change Flight Mode to: Guided........
		rover.flight_mode_trigger = 'mission_finished';
		rover.set_flight_mode(rover, 'Guided');
	}

};


module.exports = mission_item_reached;