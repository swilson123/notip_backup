var avoid_object = function (rover) {
	const AVOIDANCE_REEVALUATE_MS = 3000;
	const FRONT_CLEAR_STABLE_MS = 1400;
	const RESUME_CORRIDOR_STABLE_MS = 2400;
	const RESUME_FRONT_CLEARANCE_MM = 1200;
	const TURN_DIRECTION_HOLD_MS = 5000;
	const AVOIDANCE_TURN_YAW = 30;
	const AVOIDANCE_TURN_SPEED = 25;
	const AVOIDANCE_CREEP_SPEED = 50;
	const CREEP_CLEARANCE_DISTANCE_M = 1;
	const MIN_COMMITTED_TURN_DEGREES = 5;
	const TURN_ALIGN_STABLE_MS = 500;
	const POST_TURN_SETTLE_MS = 450;
	const FRONT_BLOCKED_CONFIRM_MS = 300;
	const FRONT_CLEAR_JITTER_MS = 350;

	function normalize_relative_angle(angle) {
		let normalized = angle % 360;
		if (normalized > 180) normalized -= 360;
		if (normalized <= -180) normalized += 360;
		return normalized;
	}

	function get_zone_center(zone) {
		return normalize_relative_angle((zone.min_angle + zone.max_angle) / 2);
	}

	function find_zone(zone_number) {
		for (let i = 0; i < rover.zones.length; i++) {
			if (rover.zones[i].zone === zone_number) {
				return rover.zones[i];
			}
		}
		return null;
	}

	function ensure_avoidance_state() {
		if (!rover.mission.avoidance_turn) {
			rover.mission.avoidance_turn = {
				phase: null,
				direction: null,
				target_zone: null,
				turn_start_heading: null,
				selected_at: null,
				blocked_since: null,
				clear_since: null,
				aligned_since: null,
				corridor_clear_since: null,
				corridor_clear_lat: null,
				corridor_clear_lon: null,
				settling_since: null
			};
		}

		return rover.mission.avoidance_turn;
	}

	function reset_avoidance_state() {
		let avoidance_turn = ensure_avoidance_state();
		avoidance_turn.phase = null;
		avoidance_turn.direction = null;
		avoidance_turn.target_zone = null;
		avoidance_turn.turn_start_heading = null;
		avoidance_turn.selected_at = null;
		avoidance_turn.blocked_since = null;
		avoidance_turn.clear_since = null;
		avoidance_turn.aligned_since = null;
		avoidance_turn.corridor_clear_since = null;
		avoidance_turn.corridor_clear_lat = null;
		avoidance_turn.corridor_clear_lon = null;
		avoidance_turn.settling_since = null;
	}

	function is_zone_clear_for_resume(zone) {
		if (!zone) {
			return true;
		}

		if (zone.light === "red") {
			return false;
		}

		if (zone.light === "yellow" && typeof zone.distance_mm === 'number' && zone.distance_mm < RESUME_FRONT_CLEARANCE_MM) {
			return false;
		}

		return true;
	}

	function is_forward_corridor_clear() {
		// Include front and front-adjacent zones for realtime safety before handoff to mission yaw logic.
		let zones_to_check = [find_zone(10), find_zone(11), find_zone(12), find_zone(1)];
		for (let i = 0; i < zones_to_check.length; i++) {
			if (!is_zone_clear_for_resume(zones_to_check[i])) {
				return false;
			}
		}

		return true;
	}

	function stop_rover() {
		rover.motor.motor_speed_cmd = 0;
		rover.motor.last_motor_speed_cmd = 0;

		rover.move_rover(rover, 1, 0, "avoid_object");
		rover.move_rover(rover, 2, 0, "avoid_object");
		rover.move_rover(rover, 3, 0, "avoid_object");
		rover.move_rover(rover, 4, 0, "avoid_object");

		rover.servo_send_command(rover, 11, 1500, false);
		rover.servo_send_command(rover, 12, 1500, false);
		rover.servo_send_command(rover, 13, 1500, false);
		rover.servo_send_command(rover, 14, 1500, false);
	}

	function resume_mission(reason) {
		stop_rover();
		rover.mission.path_clear = true;
		console.log(reason);
		reset_avoidance_state();
	}

	function move_forward_slowly() {
		rover.servo_send_command(rover, 11, 1500, true);
		rover.servo_send_command(rover, 12, 1500, true);
		rover.servo_send_command(rover, 13, 1500, true);
		rover.servo_send_command(rover, 14, 1500, true);

		if (rover.servos.motor_front_driver.set_pwm > 1400 && rover.servos.motor_front_driver.set_pwm < 1600 &&
			rover.servos.motor_back_driver.set_pwm > 1400 && rover.servos.motor_back_driver.set_pwm < 1600 &&
			rover.servos.motor_front_passenger.set_pwm > 1400 && rover.servos.motor_front_passenger.set_pwm < 1600 &&
			rover.servos.motor_back_passenger.set_pwm > 1400 && rover.servos.motor_back_passenger.set_pwm < 1600) {

			rover.move_rover(rover, 1, AVOIDANCE_CREEP_SPEED * -1, "avoid_object");
			rover.move_rover(rover, 4, AVOIDANCE_CREEP_SPEED, "avoid_object");
			rover.move_rover(rover, 3, AVOIDANCE_CREEP_SPEED, "avoid_object");
			rover.move_rover(rover, 2, AVOIDANCE_CREEP_SPEED * -1, "avoid_object");
		}
	}

	function get_yaw_to_waypoint() {
		let waypoint = { latitude: null, longitude: null };

		for (let i = 0; i < rover.mission.waypoints.length; i++) {
			if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {
				waypoint.latitude = rover.mission.waypoints[i].lat;
				waypoint.longitude = rover.mission.waypoints[i].lng;
				break;
			}
		}

		if (waypoint.latitude === null || waypoint.longitude === null) {
			return 0;
		}

		let waypoint_bearing = rover.get_bearing(
			rover.robot_data.robot_latitude,
			rover.robot_data.robot_longitude,
			waypoint.latitude,
			waypoint.longitude
		);
		let rover_heading = rover.robot_data.VFR_HUD.heading || 0;
		let yaw_to_waypoint = normalize_relative_angle(waypoint_bearing - rover_heading);

		rover.robot_data.yaw_to_waypoint = yaw_to_waypoint;
		return yaw_to_waypoint;
	}

	function get_current_heading() {
		return rover.robot_data.VFR_HUD.heading || 0;
	}

	function start_turn_commit(avoidance_turn) {
		avoidance_turn.turn_start_heading = get_current_heading();
		avoidance_turn.aligned_since = null;
	}

	function has_committed_turn(avoidance_turn) {
		if (avoidance_turn.turn_start_heading === null) {
			return false;
		}

		let heading_delta = normalize_relative_angle(get_current_heading() - avoidance_turn.turn_start_heading);
		return Math.abs(heading_delta) >= MIN_COMMITTED_TURN_DEGREES;
	}

	function is_front_blocked() {
		let zone_11 = find_zone(11);
		let zone_12 = find_zone(12);
		return (zone_11 && zone_11.light === "red") || (zone_12 && zone_12.light === "red");
	}

	function find_nearest_green_zone(yaw_to_waypoint) {
		let best_zone = null;
		let best_score = Number.POSITIVE_INFINITY;

		for (let i = 0; i < rover.zones.length; i++) {
			let zone = rover.zones[i];
			if (zone.light !== "green") {
				continue;
			}

			if (zone.zone === 11 || zone.zone === 12) {
				continue;
			}

			let zone_center = get_zone_center(zone);
			let proximity_score = Math.abs(zone_center);
			let waypoint_score = Math.abs(normalize_relative_angle(yaw_to_waypoint - zone_center));
			let total_score = proximity_score + (waypoint_score / 4);

			if (total_score < best_score) {
				best_score = total_score;
				best_zone = zone;
			}
		}

		return best_zone;
	}

	function choose_turn_target(yaw_to_waypoint) {
		let target_zone = find_nearest_green_zone(yaw_to_waypoint);
		if (!target_zone) {
			return null;
		}

		return {
			target_zone: target_zone.zone,
			direction: get_zone_center(target_zone) >= 0 ? "left" : "right"
		};
	}

	if (!rover.robot_data.mission_mode || !rover.rc_contoller.connected) {
		reset_avoidance_state();
		return;
	}

	let avoidance_turn = ensure_avoidance_state();
	let yaw_to_waypoint = get_yaw_to_waypoint();
	let front_blocked = is_front_blocked();
	let now = Date.now();

	if (front_blocked) {
		if (!avoidance_turn.blocked_since) {
			avoidance_turn.blocked_since = now;
		}
	}
	else if (avoidance_turn.blocked_since && (now - avoidance_turn.blocked_since) < FRONT_CLEAR_JITTER_MS) {
		front_blocked = true;
	}
	else {
		avoidance_turn.blocked_since = null;
	}

	if (rover.mission.path_clear) {
		if (!front_blocked) {
			reset_avoidance_state();
			return;
		}

		if ((now - avoidance_turn.blocked_since) < FRONT_BLOCKED_CONFIRM_MS) {
			return;
		}

		rover.mission.path_clear = false;
		stop_rover();

		let turn_target = choose_turn_target(yaw_to_waypoint);
		avoidance_turn.phase = "turning";
		avoidance_turn.direction = turn_target ? turn_target.direction : null;
		avoidance_turn.target_zone = turn_target ? turn_target.target_zone : null;
		start_turn_commit(avoidance_turn);
		avoidance_turn.selected_at = Date.now();

		if (turn_target) {
			console.log('Object detected! Turning ' + turn_target.direction + ' toward green zone ' + turn_target.target_zone + '.');
		}
		else {
			console.log('Object detected but no non-front green zone is available yet. Holding position.');
		}
		return;
	}

	if (front_blocked) {
		avoidance_turn.clear_since = null;
		avoidance_turn.corridor_clear_since = null;
		avoidance_turn.aligned_since = null;
		avoidance_turn.settling_since = null;

		if (avoidance_turn.phase !== "turning") {
			stop_rover();
			avoidance_turn.phase = "turning";
			start_turn_commit(avoidance_turn);
			// Keep previously selected direction if available to avoid left/right ping-pong
			// when a second obstacle appears shortly after creeping.
			if (!avoidance_turn.selected_at) {
				avoidance_turn.selected_at = Date.now();
			}
		}

		let should_reevaluate = !avoidance_turn.target_zone ||
			!avoidance_turn.direction ||
			(avoidance_turn.selected_at + AVOIDANCE_REEVALUATE_MS < Date.now());

		if (should_reevaluate) {
			let turn_target = choose_turn_target(yaw_to_waypoint);
			let selected_direction = turn_target ? turn_target.direction : null;
			let selected_zone = turn_target ? turn_target.target_zone : null;

			let turning_recently = avoidance_turn.selected_at && ((Date.now() - avoidance_turn.selected_at) < TURN_DIRECTION_HOLD_MS);
			let direction_flip = avoidance_turn.direction && selected_direction && avoidance_turn.direction !== selected_direction;

			if (turning_recently && direction_flip) {
				selected_direction = avoidance_turn.direction;
				selected_zone = avoidance_turn.target_zone;
			}

			if (avoidance_turn.direction !== selected_direction) {
				start_turn_commit(avoidance_turn);
			}

			avoidance_turn.direction = selected_direction;
			avoidance_turn.target_zone = selected_zone;
			avoidance_turn.selected_at = Date.now();

			if (turn_target) {
				console.log('Re-evaluating obstacle avoidance. Turning ' + turn_target.direction + ' toward green zone ' + turn_target.target_zone + '.');
			}
			else {
				console.log('Front is blocked and no non-front green zone is available. Holding position.');
			}
		}

		if (!avoidance_turn.direction) {
			stop_rover();
			return;
		}

		let yaw_command = avoidance_turn.direction === "left" ? AVOIDANCE_TURN_YAW : AVOIDANCE_TURN_YAW * -1;
		rover.yaw_rover(rover, yaw_command, AVOIDANCE_TURN_SPEED);
		return;
	}

	if (avoidance_turn.phase === "turning") {
		if (!has_committed_turn(avoidance_turn) && avoidance_turn.direction) {
			let yaw_command = avoidance_turn.direction === "left" ? AVOIDANCE_TURN_YAW : AVOIDANCE_TURN_YAW * -1;
			rover.yaw_rover(rover, yaw_command, AVOIDANCE_TURN_SPEED);
			return;
		}

		if ((now - avoidance_turn.blocked_since) < FRONT_CLEAR_JITTER_MS) {
			let yaw_command = avoidance_turn.direction === "left" ? AVOIDANCE_TURN_YAW : AVOIDANCE_TURN_YAW * -1;
			rover.yaw_rover(rover, yaw_command, AVOIDANCE_TURN_SPEED);
			return;
		}

		// Front is no longer blocked. Hold stopped briefly so turn-down is smooth
		// before transitioning to creep.
		if (!avoidance_turn.aligned_since) {
			avoidance_turn.aligned_since = now;
		}

		if ((now - avoidance_turn.aligned_since) >= TURN_ALIGN_STABLE_MS) {
			stop_rover();
			avoidance_turn.phase = "settling";
			avoidance_turn.settling_since = now;
			return;
		}

		stop_rover();
		return;
	}

	if (avoidance_turn.phase === "settling") {
		if (!avoidance_turn.settling_since) {
			avoidance_turn.settling_since = now;
		}

		if ((now - avoidance_turn.settling_since) < POST_TURN_SETTLE_MS) {
			stop_rover();
			return;
		}
	}

	if (!avoidance_turn.clear_since) {
		avoidance_turn.clear_since = now;
	}

	let corridor_is_clear = is_forward_corridor_clear();
	if (corridor_is_clear) {
		if (!avoidance_turn.corridor_clear_since) {
			avoidance_turn.corridor_clear_since = now;
			avoidance_turn.corridor_clear_lat = rover.robot_data.robot_latitude;
			avoidance_turn.corridor_clear_lon = rover.robot_data.robot_longitude;
		}
	}
	else {
		avoidance_turn.corridor_clear_since = null;
		avoidance_turn.corridor_clear_lat = null;
		avoidance_turn.corridor_clear_lon = null;
	}

	let front_clear_stable = (now - avoidance_turn.clear_since) >= FRONT_CLEAR_STABLE_MS;
	let corridor_stable = avoidance_turn.corridor_clear_since && ((now - avoidance_turn.corridor_clear_since) >= RESUME_CORRIDOR_STABLE_MS);

	let creep_distance_met = false;
	if (avoidance_turn.corridor_clear_lat !== null && avoidance_turn.corridor_clear_lon !== null) {
		let distance_since_clear_m = rover.gps_distance(avoidance_turn.corridor_clear_lat, avoidance_turn.corridor_clear_lon, rover.robot_data.robot_latitude, rover.robot_data.robot_longitude) * 1000;
		creep_distance_met = distance_since_clear_m >= CREEP_CLEARANCE_DISTANCE_M;
	}

	if (front_clear_stable && corridor_stable && creep_distance_met) {
		resume_mission('Front corridor clear. Returning control to mission navigation.');
		return;
	}

	avoidance_turn.phase = "creeping";
	avoidance_turn.aligned_since = null;
	avoidance_turn.settling_since = null;
	move_forward_slowly();
}

module.exports = avoid_object;