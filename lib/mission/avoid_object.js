var avoid_object = function (rover) {

	// Helper: Find nearest green zone to a given yaw angle
	function find_nearest_green_zone(zones, yaw_angle) {
		let min_diff = 360;
		let best_zone = null;
		for (let i = 0; i < zones.length; i++) {
			if (zones[i].light === "green") {
				// Find center of zone
				if (zones[i].zone != 11 && zones[i].zone != "12") {
					let center = (zones[i].min_angle + zones[i].max_angle) / 2;
					let diff = Math.abs(((yaw_angle - center + 540) % 360) - 180); // shortest angle diff
					if (diff < min_diff) {
						min_diff = diff;
						best_zone = zones[i];
					}
				}
			}
		}
		return best_zone;
	}

	if (rover.robot_data.mission_mode && rover.rc_contoller.connected) {

		let green_zone_found = find_nearest_green_zone(rover.zones, 0);

		if (green_zone_found) {


			//is zone 12 and 11 green?
			if (rover.zones[10].light == "red" || rover.zones[11].light == "red") {
				//object has been detected in path.......
				if (rover.mission.path_clear) {
					rover.mission.path_clear = false;
					console.log('Object detected!');

					//stop the rover	

					rover.move_rover(rover, 1, 0, "avoid_object");
					rover.move_rover(rover, 2, 0, "avoid_object");
					rover.move_rover(rover, 3, 0, "avoid_object");
					rover.move_rover(rover, 4, 0, "avoid_object");

					//turn wheels straight
					rover.servo_send_command(rover, 11, 1500, false);
					rover.servo_send_command(rover, 12, 1500, false);
					rover.servo_send_command(rover, 13, 1500, false);
					rover.servo_send_command(rover, 14, 1500, false);
				}


			}

			//Path is not clear look for alternative route
			if (!rover.mission.path_clear) {



				// Find next waypoint
				let waypoint = { latitude: null, longitude: null };
				for (let i = 0; i < rover.mission.waypoints.length; i++) {
					if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {
						waypoint.latitude = rover.mission.waypoints[i].lat;
						waypoint.longitude = rover.mission.waypoints[i].lng;
					}
				}
				// Calculate bearing and yaw
				let waypoint_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
				let rover_heading = rover.robot_data.VFR_HUD.heading || 0;
				let yaw_to_waypoint = (waypoint_bearing - rover_heading + 360) % 360;
				if (yaw_to_waypoint > 180) yaw_to_waypoint -= 360;
				rover.robot_data.yaw_to_waypoint = yaw_to_waypoint;
				//console.log('rover_heading:', rover_heading + " yaw_to_waypoint: " + yaw_to_waypoint + " waypoint_bearing: " + waypoint_bearing);


				//is there a green zone facing the waypoint? (use waypoint_bearing)
				for (var i = 0; i < rover.zones.length; i++) {
					if (rover.zones[i].light == "green") {
						if (rover.zones[i].timestamp + 2000 < Date.now()) {
							let zone_center = (rover.zones[i].min_angle + rover.zones[i].max_angle) / 2;

							if (rover.zones[i].zone == 10 && rover.zones[11].light == "red") {
								zone_center = (rover.zones[9].min_angle + rover.zones[9].max_angle) / 2;
							}
							else if (rover.zones[i].zone == 10 && rover.zones[9].light == "red") {
								zone_center = (rover.zones[11].min_angle + rover.zones[11].max_angle) / 2;
							}


							if (rover.zones[i].zone == 11 && rover.zones[0].light == "red") {
								zone_center = (rover.zones[10].min_angle + rover.zones[10].max_angle) / 2;
							}
							else if (rover.zones[i].zone == 11 && rover.zones[10].light == "red") {
								zone_center = (rover.zones[0].min_angle + rover.zones[0].max_angle) / 2;
							}

							(rover.zones[i].min_angle - rover_heading + 360) % 360;
							let angle_diff = Math.abs(((yaw_to_waypoint - zone_center + 540) % 360) - 180);
							if (angle_diff < 30) { // within 30 degrees of yaw to waypoint


								//zone has been green for 2 seconds
								console.log(`Green zone ${rover.zones[i].zone} is facing yaw to waypoint ${yaw_to_waypoint}`);
								//Resume mission if there is a green zone facing the waypoint
								if (rover.zones[10].light == "green" && rover.zones[11].light == "green") {
									rover.mission.path_clear = true;
									console.log('Path to waypoint is clear, resuming mission.');
								}
								else if (rover.zones[10].light === "green" && Math.abs(yaw_to_waypoint) < 5) {
									rover.mission.path_clear = true;
									console.log('Zone: ' + rover.zones[i].zone + " clear to waypoint, resuming mission.");
								}
								else if (rover.zones[11].light === "green" && Math.abs(yaw_to_waypoint) < 5) {
									rover.mission.path_clear = true;
									console.log('Zone: ' + rover.zones[i].zone + " clear to waypoint, resuming mission.");
								}
								else {
									console.log('yawing to green zone ', rover.zones[i].zone);
									motor_speed_cmd = Math.abs(yaw_to_waypoint);
									rover.yaw_rover(rover, yaw_to_waypoint, motor_speed_cmd);
								}


								return; // exit function after commanding forward
							}
						}
					}
				}

				// No green zone directly facing waypoint
				if (!rover.mission.path_clear) {
					if (rover.zones[10].light == "red" || rover.zones[11].light == "red") {
						// If path ahead is blocked, find nearest green zone to waypoint bearing
						let nearest_green = find_nearest_green_zone(rover.zones, waypoint_bearing);
						if (nearest_green) {
							let green_center = (nearest_green.min_angle + nearest_green.max_angle) / 2;
							let yaw_to_green = (green_center - rover_heading + 360) % 360;
							yaw_to_green = yaw_to_green * -1;
							if (yaw_to_green > 180) {
								yaw_to_green -= 360;
							}
							console.log(`Yawing to nearest green zone: Zone ${nearest_green.zone}, center angle ${green_center}, yaw ${yaw_to_green}`);
							motor_speed_cmd = Math.abs(yaw_to_green);
							rover.yaw_rover(rover, yaw_to_green, motor_speed_cmd);
						} else {
							console.log('No green zone available, holding position.');
						}
					}
					else {
						//command rover to move forward
						console.log('Path ahead is clear, moving forward slowly.');

						//turn wheels straight
						rover.servo_send_command(rover, 11, 1500, false);
						rover.servo_send_command(rover, 12, 1500, false);
						rover.servo_send_command(rover, 13, 1500, false);
						rover.servo_send_command(rover, 14, 1500, false);

						let motor_speed_cmd = 50;
						setTimeout(() => {
							rover.move_rover(rover, 1, motor_speed_cmd * -1, "avoid_object");
						}, 10);
						setTimeout(() => {
							rover.move_rover(rover, 4, motor_speed_cmd, "avoid_object");
						}, 20);
						setTimeout(() => {
							rover.move_rover(rover, 3, motor_speed_cmd, "avoid_object");
						}, 30);
						setTimeout(() => {
							rover.move_rover(rover, 2, motor_speed_cmd * -1, "avoid_object");
						}, 40);
					}
				}

			}

		}
		else{
			console.log('No green zones detected, holding position.');
		}
	}

}

module.exports = avoid_object;