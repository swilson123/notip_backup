var avoid_object = function (white_rabbit) {
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
		for (let i = 0; i < white_rabbit.zones.length; i++) {
			if (white_rabbit.zones[i].zone === zone_number) {
				return white_rabbit.zones[i];
			}
		}
		return null;
	}

	function ensure_avoidance_state() {
		if (!white_rabbit.mission.avoidance_turn) {
			white_rabbit.mission.avoidance_turn = {
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
				settling_since: null,
				avoidance_started_at: null
			};
		}

		return white_rabbit.mission.avoidance_turn;
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
		avoidance_turn.avoidance_started_at = null;
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

	function stop_white_rabbit() {
		white_rabbit.motor.motor_speed_cmd = 0;
		white_rabbit.motor.last_motor_speed_cmd = 0;

		white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "avoid_object");
		white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "avoid_object");
		white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "avoid_object");
		white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "avoid_object");

		white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
		white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
		white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
		white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
	}

	function resume_mission(reason) {
		stop_white_rabbit();
		white_rabbit.mission.path_clear = true;
		white_rabbit.mission.avoidance_timed_out = false;
		console.log(reason);
		white_rabbit.logs.avoid_object.log(white_rabbit, reason);
		reset_avoidance_state();
	}

	function move_forward_slowly() {
		white_rabbit.servo_send_command(white_rabbit, 11, 1500, true);
		white_rabbit.servo_send_command(white_rabbit, 12, 1500, true);
		white_rabbit.servo_send_command(white_rabbit, 13, 1500, true);
		white_rabbit.servo_send_command(white_rabbit, 14, 1500, true);

		if (white_rabbit.servos.motor_front_driver.set_pwm > 1400 && white_rabbit.servos.motor_front_driver.set_pwm < 1600 &&
			white_rabbit.servos.motor_back_driver.set_pwm > 1400 && white_rabbit.servos.motor_back_driver.set_pwm < 1600 &&
			white_rabbit.servos.motor_front_passenger.set_pwm > 1400 && white_rabbit.servos.motor_front_passenger.set_pwm < 1600 &&
			white_rabbit.servos.motor_back_passenger.set_pwm > 1400 && white_rabbit.servos.motor_back_passenger.set_pwm < 1600) {

			white_rabbit.move_white_rabbit(white_rabbit, 1, AVOIDANCE_CREEP_SPEED * -1, "avoid_object");
			white_rabbit.move_white_rabbit(white_rabbit, 4, AVOIDANCE_CREEP_SPEED, "avoid_object");
			white_rabbit.move_white_rabbit(white_rabbit, 3, AVOIDANCE_CREEP_SPEED, "avoid_object");
			white_rabbit.move_white_rabbit(white_rabbit, 2, AVOIDANCE_CREEP_SPEED * -1, "avoid_object");
		}
	}

	function get_yaw_to_waypoint() {
		let waypoint = { latitude: null, longitude: null };

		for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
			if (white_rabbit.mission.waypoints[i].seq == white_rabbit.mission.current_mission_seq) {
				waypoint.latitude = white_rabbit.mission.waypoints[i].lat;
				waypoint.longitude = white_rabbit.mission.waypoints[i].lng;
				break;
			}
		}

		if (waypoint.latitude === null || waypoint.longitude === null) {
			return 0;
		}

		let waypoint_bearing = white_rabbit.get_bearing(
			white_rabbit.robot_data.robot_latitude,
			white_rabbit.robot_data.robot_longitude,
			waypoint.latitude,
			waypoint.longitude
		);
		let white_rabbit_heading = white_rabbit.get_heading(white_rabbit);
		let yaw_to_waypoint = normalize_relative_angle(waypoint_bearing - white_rabbit_heading);

		white_rabbit.robot_data.yaw_to_waypoint = yaw_to_waypoint;
		return yaw_to_waypoint;
	}

	function get_current_heading() {
		return white_rabbit.get_heading(white_rabbit);
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
		if ((zone_11 && zone_11.light === "red") || (zone_12 && zone_12.light === "red")) {
			return true;
		}
		// Also check RealSense vision zones. Camera (0.406 m) sees low obstacles the lidar (0.61 m) misses.
		// Each clock zone (10→11, 11→12, 12→1, 1→2) requires 1 second of sustained detection before
		// its light turns red, preventing spurious stops from momentary camera noise
		if (white_rabbit.realsense && white_rabbit.realsense.vision_zones &&
				!(white_rabbit.mission && white_rabbit.mission.package_delivered)) {
			let detection = white_rabbit.realsense.path_detection;
			let vision = white_rabbit.realsense.vision || {};
			let fresh = detection && detection.timestamp &&
				(Date.now() - detection.timestamp) < (vision.stale_detection_ms || 1200);
			if (fresh) {
				let front_zones = [11, 12, 1];
				for (let i = 0; i < front_zones.length; i++) {
					let vz = white_rabbit.realsense.vision_zones[front_zones[i]];
					if (vz && vz.light === 'red') {
						return true;
					}
				}
			}
		}
		return false;
	}

	function find_nearest_green_zone(yaw_to_waypoint) {
		let best_zone = null;
		let best_score = Number.POSITIVE_INFINITY;

		for (let i = 0; i < white_rabbit.zones.length; i++) {
			let zone = white_rabbit.zones[i];
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

		// Positive zone center = right side of white_rabbit (clock zones 1-5); negative = left (zones 6-10).
		return {
			target_zone: target_zone.zone,
			direction: get_zone_center(target_zone) >= 0 ? "right" : "left"
		};
	}

	if (!white_rabbit.robot_data.mission_mode || !white_rabbit.rc_contoller.connected) {
		reset_avoidance_state();
		return;
	}

	if (!white_rabbit.rplidar.avoid_object) {
		reset_avoidance_state();
		return;
	}

	let avoidance_turn = ensure_avoidance_state();
	let yaw_to_waypoint = get_yaw_to_waypoint();
	let front_blocked = is_front_blocked();
	let now = Date.now();

	if (white_rabbit.mission && white_rabbit.mission.avoidance_start_grace_until && now < white_rabbit.mission.avoidance_start_grace_until) {
		stop_white_rabbit();
		white_rabbit.mission.path_clear = true;
		reset_avoidance_state();
		return;
	}
	if (white_rabbit.mission && white_rabbit.mission.avoidance_start_grace_until && now >= white_rabbit.mission.avoidance_start_grace_until) {
		white_rabbit.mission.avoidance_start_grace_until = null;
	}

	// Mission-start gate: do not let stale pre-start detections trigger avoidance
	// before we have committed to the first leg.
	if (white_rabbit.mission && !white_rabbit.mission.package_delivered) {
		let commit_distance_m = (white_rabbit.nav_tuning && typeof white_rabbit.nav_tuning.first_leg_commit_distance_m === 'number')
			? white_rabbit.nav_tuning.first_leg_commit_distance_m
			: 1.0;

		if (white_rabbit.mission.current_mission_seq > 1) {
			white_rabbit.mission.first_leg_committed = true;
		}

		if (!white_rabbit.mission.first_leg_start_lat || !white_rabbit.mission.first_leg_start_lng) {
			white_rabbit.mission.first_leg_start_lat = white_rabbit.robot_data.robot_latitude || null;
			white_rabbit.mission.first_leg_start_lng = white_rabbit.robot_data.robot_longitude || null;
		}

		if (!white_rabbit.mission.first_leg_committed
			&& white_rabbit.mission.first_leg_start_lat
			&& white_rabbit.mission.first_leg_start_lng
			&& white_rabbit.robot_data.robot_latitude
			&& white_rabbit.robot_data.robot_longitude) {
			let moved_m = white_rabbit.gps_distance(
				white_rabbit.mission.first_leg_start_lat,
				white_rabbit.mission.first_leg_start_lng,
				white_rabbit.robot_data.robot_latitude,
				white_rabbit.robot_data.robot_longitude
			) * 1000;
			if (moved_m >= commit_distance_m) {
				white_rabbit.mission.first_leg_committed = true;
				white_rabbit.logs.avoid_object.log(white_rabbit, 'First-leg committed after ' + moved_m.toFixed(2) + 'm; obstacle avoidance enabled.');
			}
		}

		if (!white_rabbit.mission.first_leg_committed) {
			white_rabbit.mission.path_clear = true;
			reset_avoidance_state();
			return;
		}
	}

	// Global avoidance timeout: if the white_rabbit has been in avoidance continuously for too long,
	// flag it so run_mission can trigger fallback delivery instead of spinning indefinitely.
	if (avoidance_turn.avoidance_started_at) {
		let avoidance_timeout_ms = (white_rabbit.nav_tuning && white_rabbit.nav_tuning.avoidance_timeout_ms) || 30000;
		if (now - avoidance_turn.avoidance_started_at >= avoidance_timeout_ms) {
			white_rabbit.mission.avoidance_timed_out = true;
			white_rabbit.logs.avoid_object.log(white_rabbit, 'Avoidance timeout after ' + avoidance_timeout_ms + 'ms — flagging for fallback delivery');
		}
	}

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

	if (white_rabbit.mission.path_clear) {
		if (!front_blocked) {
			reset_avoidance_state();
			return;
		}

		if ((now - avoidance_turn.blocked_since) < FRONT_BLOCKED_CONFIRM_MS) {
			return;
		}

		white_rabbit.mission.path_clear = false;
		stop_white_rabbit();

		let turn_target = choose_turn_target(yaw_to_waypoint);
		avoidance_turn.phase = "turning";
		avoidance_turn.direction = turn_target ? turn_target.direction : null;
		avoidance_turn.target_zone = turn_target ? turn_target.target_zone : null;
		start_turn_commit(avoidance_turn);
		avoidance_turn.selected_at = Date.now();
		if (!avoidance_turn.avoidance_started_at) {
            avoidance_turn.avoidance_started_at = now;
            if (white_rabbit.intelligence) white_rabbit.intelligence.consider('avoidance_started');
        }

		if (turn_target) {
			let msg = 'Object detected! Turning ' + turn_target.direction + ' toward green zone ' + turn_target.target_zone + '.';
			console.log(msg);
			white_rabbit.logs.avoid_object.log(white_rabbit, msg);
		}
		else {
			let msg = 'Object detected but no non-front green zone is available yet. Holding position.';
			console.log(msg);
			white_rabbit.logs.avoid_object.log(white_rabbit, msg);
		}
		return;
	}

	if (front_blocked) {
		avoidance_turn.clear_since = null;
		avoidance_turn.corridor_clear_since = null;
		avoidance_turn.aligned_since = null;
		avoidance_turn.settling_since = null;

		if (avoidance_turn.phase !== "turning") {
			stop_white_rabbit();
			avoidance_turn.phase = "turning";
			start_turn_commit(avoidance_turn);
			// Keep previously selected direction if available to avoid left/right ping-pong
			// when a second obstacle appears shortly after creeping.
			if (!avoidance_turn.selected_at) {
				avoidance_turn.selected_at = Date.now();
			}
			if (!avoidance_turn.avoidance_started_at) avoidance_turn.avoidance_started_at = now;
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
				let msg = 'Re-evaluating obstacle avoidance. Turning ' + turn_target.direction + ' toward green zone ' + turn_target.target_zone + '.';
				console.log(msg);
				white_rabbit.logs.avoid_object.log(white_rabbit, msg);
			}
			else {
				let msg = 'Front is blocked and no non-front green zone is available. Holding position.';
				console.log(msg);
				white_rabbit.logs.avoid_object.log(white_rabbit, msg);
			}
		}

		if (!avoidance_turn.direction) {
			stop_white_rabbit();
			return;
		}

		let yaw_command = avoidance_turn.direction === "right" ? AVOIDANCE_TURN_YAW : AVOIDANCE_TURN_YAW * -1;
		white_rabbit.yaw_white_rabbit(white_rabbit, yaw_command, AVOIDANCE_TURN_SPEED);
		return;
	}

	if (avoidance_turn.phase === "turning") {
		if (!has_committed_turn(avoidance_turn) && avoidance_turn.direction) {
			let yaw_command = avoidance_turn.direction === "right" ? AVOIDANCE_TURN_YAW : AVOIDANCE_TURN_YAW * -1;
			white_rabbit.yaw_white_rabbit(white_rabbit, yaw_command, AVOIDANCE_TURN_SPEED);
			return;
		}

		if ((now - avoidance_turn.blocked_since) < FRONT_CLEAR_JITTER_MS) {
			let yaw_command = avoidance_turn.direction === "right" ? AVOIDANCE_TURN_YAW : AVOIDANCE_TURN_YAW * -1;
			white_rabbit.yaw_white_rabbit(white_rabbit, yaw_command, AVOIDANCE_TURN_SPEED);
			return;
		}

		// Front is no longer blocked. Hold stopped briefly so turn-down is smooth
		// before transitioning to creep.
		if (!avoidance_turn.aligned_since) {
			avoidance_turn.aligned_since = now;
		}

		if ((now - avoidance_turn.aligned_since) >= TURN_ALIGN_STABLE_MS) {
			stop_white_rabbit();
			avoidance_turn.phase = "settling";
			avoidance_turn.settling_since = now;
			return;
		}

		stop_white_rabbit();
		return;
	}

	if (avoidance_turn.phase === "settling") {
		if (!avoidance_turn.settling_since) {
			avoidance_turn.settling_since = now;
		}

		if ((now - avoidance_turn.settling_since) < POST_TURN_SETTLE_MS) {
			stop_white_rabbit();
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
			avoidance_turn.corridor_clear_lat = white_rabbit.robot_data.robot_latitude;
			avoidance_turn.corridor_clear_lon = white_rabbit.robot_data.robot_longitude;
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
		let distance_since_clear_m = white_rabbit.gps_distance(avoidance_turn.corridor_clear_lat, avoidance_turn.corridor_clear_lon, white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude) * 1000;
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