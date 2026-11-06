//Atlas ground station: the car uploads the dispatch's waypoints to the Pixhawk after Noah arms, then sends MSN_RDY.
//Until that fresh mission is fully downloaded here, Noah must not start - the Pixhawk may still hold the last house's mission.
var atlas_mission_ready = function (white_rabbit) {

	//Mission Planner: the mission was written to the Pixhawk before arming
	if (white_rabbit.car.atlas !== 1) {
		return true;
	}

	return white_rabbit.mission.atlas_mission_ready &&
		white_rabbit.mission.mission_count > 0 &&
		white_rabbit.mission.waypoints.length >= white_rabbit.mission.mission_count;
};


module.exports = atlas_mission_ready;
