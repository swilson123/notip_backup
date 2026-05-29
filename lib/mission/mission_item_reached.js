//sends message to radio and websocket........................
var mission_item_reached = function (white_rabbit, message) {
	console.log('MISSION_ITEM_REACHED - ', message.seq);
	white_rabbit.mission.last_reached_mission_seq = message.seq;
	// Guard: run_mission.js advances current_mission_seq internally when the white_rabbit enters the
	// arrival radius. If this MAVLink event fires after that, skip to avoid double-increment.
	if (message.seq + 1 <= white_rabbit.mission.current_mission_seq) {
		console.log('MISSION_ITEM_REACHED - skipping seq', message.seq, '(already at', white_rabbit.mission.current_mission_seq, ')');
		return;
	}
    white_rabbit.mission.current_mission_seq = message.seq + 1;


	//Update waypoint array
	for (var i = 0; i < white_rabbit.mission.waypoints.length; i++) {
		if (white_rabbit.mission.waypoints[i].seq == message.seq) {
			white_rabbit.mission.waypoints[i].reached = true;
		}
	}

	if (white_rabbit.mission.mission_count == white_rabbit.mission.current_mission_seq) {
		//Change Flight Mode to: Guided........
		white_rabbit.flight_mode_trigger = 'mission_finished';
		white_rabbit.set_flight_mode(white_rabbit, 'Guided');
	}

};


module.exports = mission_item_reached;