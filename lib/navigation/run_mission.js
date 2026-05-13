function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function get_history_analysis(history, vision) {
    let result = { weighted_offset_meters: null, sustained_seeking: false, confidence_rising: false };
    if (!history || history.length === 0) return result;

    let now          = Date.now();
    let seek_enter_m = vision && typeof vision.sidewalk_seek_offset_m === 'number' ? vision.sidewalk_seek_offset_m : 0.1;
    let conf_floor   = vision && typeof vision.sidewalk_seek_confidence_threshold === 'number' ? vision.sidewalk_seek_confidence_threshold : 0.4;

    // Weighted average offset: exponential decay half-life ~2 s, confidence-weighted
    let weight_sum = 0, weighted_offset = 0;
    for (let i = 0; i < history.length; i++) {
        let e = history[i];
        if (e.confidence < 0.3) continue;
        let age_s = (now - e.timestamp) / 1000;
        let w = Math.exp(-age_s * 0.35) * e.confidence;
        weighted_offset += e.offset_meters * w;
        weight_sum += w;
    }
    if (weight_sum >= 0.01) result.weighted_offset_meters = weighted_offset / weight_sum;

    // Sustained offset: last 3 s has ≥60 % of frames above threshold, ≥75 % same direction
    let sustained = history.filter(e => e.timestamp >= now - 3000 && e.confidence >= conf_floor);
    if (sustained.length >= 5) {
        let above = sustained.filter(e => Math.abs(e.offset_meters) > seek_enter_m);
        if (above.length >= sustained.length * 0.6) {
            let pos = above.filter(e => e.offset_meters > 0).length;
            let neg = above.length - pos;
            if (pos >= above.length * 0.75 || neg >= above.length * 0.75) result.sustained_seeking = true;
        }
    }

    // Confidence trend: avg confidence last 1 s vs 1–3 s ago; rising by >0.1 means sidewalk entering frame
    let recent = history.filter(e => e.timestamp >= now - 1000);
    let older  = history.filter(e => e.timestamp >= now - 3000 && e.timestamp < now - 1000);
    if (recent.length >= 2 && older.length >= 2) {
        let avg_recent = recent.reduce((s, e) => s + e.confidence, 0) / recent.length;
        let avg_older  = older.reduce((s, e)  => s + e.confidence, 0) / older.length;
        result.confidence_rising = (avg_recent - avg_older) > 0.1;
    }

    return result;
}

function get_realsense_steering_bias_deg(rover, seeking, ha) {
    if (!rover.realsense || !rover.realsense.vision || !rover.realsense.vision.enabled) {
        return 0;
    }

    // Disable path steering bias during return trip — rover navigates in reverse by waypoints.
    if (rover.mission && rover.mission.package_delivered) {
        return 0;
    }

    let detection = rover.realsense.path_detection;
    let vision = rover.realsense.vision;

    if (!detection || !detection.timestamp) {
        return 0;
    }

    if (Date.now() - detection.timestamp > vision.stale_detection_ms) {
        detection.applied_steering_bias_deg = 0;
        return 0;
    }

    // Junction/merge zone: path appears much wider than a normal sidewalk corridor.
    // Centering toward the merged center would pull the rover off the turn, so bail out.
    if (detection.path_width_meters > 1.5) {
        detection.applied_steering_bias_deg = 0;
        return 0;
    }

    let conf_threshold = seeking && typeof vision.sidewalk_seek_confidence_threshold === 'number'
        ? vision.sidewalk_seek_confidence_threshold
        : vision.confidence_threshold;
    // Confidence trend: sidewalk is entering frame — lower threshold so correction starts earlier
    if (ha && ha.confidence_rising) conf_threshold *= 0.75;
    if (detection.confidence < conf_threshold) {
        detection.applied_steering_bias_deg = 0;
        return 0;
    }

    // Weighted average offset smooths out single noisy frames; fall back to current frame if no history
    let effective_offset = (ha && ha.weighted_offset_meters !== null) ? ha.weighted_offset_meters : detection.offset_meters;

    if (Math.abs(effective_offset) < vision.path_center_deadband_m) {
        detection.applied_steering_bias_deg = 0;
        return 0;
    }

    let offset_correction = effective_offset * vision.correction_gain_deg_per_meter * vision.correction_direction * detection.confidence;

    let heading_gain = typeof vision.heading_correction_gain === 'number' ? vision.heading_correction_gain : 0.3;
    let heading_correction = (detection.heading_offset_deg || 0) * heading_gain * vision.correction_direction;

    let correction = offset_correction + heading_correction;
    correction = clamp(correction, vision.max_steering_offset_deg * -1, vision.max_steering_offset_deg);
    detection.applied_steering_bias_deg = correction;

    return correction;
}

function get_gps_crosstrack_bias_deg(rover, target_lat, target_lng) {
    if (!rover.mission || rover.mission.package_delivered) {
        return 0;
    }

    let current_seq = rover.mission.current_mission_seq;
    let prev_seq = current_seq - 1;

    let prev_waypoint = null;
    for (let i = 0; i < rover.mission.waypoints.length; i++) {
        if (rover.mission.waypoints[i].seq === prev_seq &&
            rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
            prev_waypoint = rover.mission.waypoints[i];
            break;
        }
    }

    if (!prev_waypoint) return 0;

    let rover_lat = rover.robot_data.robot_latitude;
    let rover_lng = rover.robot_data.robot_longitude;

    let track_bearing = rover.get_bearing(prev_waypoint.lat, prev_waypoint.lng, target_lat, target_lng);
    let bearing_prev_to_rover = rover.get_bearing(prev_waypoint.lat, prev_waypoint.lng, rover_lat, rover_lng);
    let dist_from_prev_m = rover.gps_distance(prev_waypoint.lat, prev_waypoint.lng, rover_lat, rover_lng) * 1000;

    let bearing_diff_rad = (bearing_prev_to_rover - track_bearing) * Math.PI / 180;
    let crosstrack_m = Math.sin(bearing_diff_rad) * dist_from_prev_m;

    // Discard if GPS appears wildly off-track (likely noise)
    if (Math.abs(crosstrack_m) > 3.0) return 0;
    if (Math.abs(crosstrack_m) < 0.3) return 0;

    // Positive crosstrack = rover right of track → steer left (negative)
    let correction = -crosstrack_m * 5.0;
    return clamp(correction, -6, 6);
}

// Computes a destination lat/lng given a start point, bearing, and distance in meters.
function destination_from_point(lat, lng, bearing_deg, distance_m) {
    const R = 6371000;
    const d = distance_m / R;
    const lat1 = lat * Math.PI / 180;
    const lng1 = lng * Math.PI / 180;
    const brng = bearing_deg * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

// Returns a nav target lat/lng laterally shifted toward the sidewalk center.
// Original waypoint coordinates are preserved for arrival detection; only the bearing target changes.
function get_adjusted_nav_target(rover, waypoint_lat, waypoint_lng, waypoint_bearing, dist_to_waypoint_m, ha, seeking) {
    const no_adjust = { latitude: waypoint_lat, longitude: waypoint_lng };
    if (!rover.realsense || !rover.realsense.vision || !rover.realsense.vision.enabled) return no_adjust;
    if (rover.mission && rover.mission.package_delivered) return no_adjust;

    let detection = rover.realsense.path_detection;
    let vision = rover.realsense.vision;

    if (!detection || !detection.timestamp) return no_adjust;
    if (Date.now() - detection.timestamp > vision.stale_detection_ms) {
        detection.applied_lateral_adjust_m = 0;
        return no_adjust;
    }
    if (detection.path_width_meters > 1.5) {
        detection.applied_lateral_adjust_m = 0;
        return no_adjust;
    }

    let conf_threshold = seeking && typeof vision.sidewalk_seek_confidence_threshold === 'number'
        ? vision.sidewalk_seek_confidence_threshold
        : vision.confidence_threshold;
    if (detection.confidence < conf_threshold) {
        detection.applied_lateral_adjust_m = 0;
        return no_adjust;
    }

    let effective_offset = (ha && ha.weighted_offset_meters !== null) ? ha.weighted_offset_meters : detection.offset_meters;
    if (Math.abs(effective_offset) < vision.path_center_deadband_m) {
        detection.applied_lateral_adjust_m = 0;
        return no_adjust;
    }

    let max_lateral_m = typeof vision.max_lateral_adjust_m === 'number' ? vision.max_lateral_adjust_m : 0.5;
    let correction_direction = typeof vision.correction_direction === 'number' ? vision.correction_direction : -1;

    // positive lateral_m = shift target LEFT of travel direction
    // rover right of center (effective_offset > 0), correction_direction = -1 → lateral_m > 0 → shift left ✓
    let lateral_m = clamp(effective_offset * correction_direction * -1, -max_lateral_m, max_lateral_m);

    // Fade the adjustment to zero as the rover nears the waypoint so arrival detection is clean
    let fade_scale = dist_to_waypoint_m < 5.0 ? clamp(dist_to_waypoint_m / 5.0, 0, 1) : 1.0;
    lateral_m *= fade_scale;

    detection.applied_lateral_adjust_m = lateral_m;

    // perp_bearing points LEFT of travel direction; negative lateral_m shifts right
    let perp_bearing = (waypoint_bearing - 90 + 360) % 360;
    let adjusted = destination_from_point(waypoint_lat, waypoint_lng, perp_bearing, lateral_m);
    return { latitude: adjusted.lat, longitude: adjusted.lng };
}

// Returns true when a high-threat RealSense object is continuously blocking the path.
// Does NOT require lidar avoidance mode — used independently for the fallback-delivery timer.
function is_realsense_path_blocked(rover) {
    if (!rover.realsense || !rover.realsense.vision || !rover.realsense.vision.enabled) return false;
    if (rover.mission && rover.mission.package_delivered) return false;
    if (!Array.isArray(rover.realsense.objects) || rover.realsense.objects.length === 0) return false;
    let detection = rover.realsense.path_detection;
    let vision = rover.realsense.vision;
    if (!detection || !detection.timestamp) return false;
    if (Date.now() - detection.timestamp > (vision.stale_detection_ms || 1200)) return false;
    let stop_dist = typeof vision.object_emergency_stop_m === 'number' ? vision.object_emergency_stop_m : 1.0;
    for (let i = 0; i < rover.realsense.objects.length; i++) {
        let obj = rover.realsense.objects[i];
        if (obj.in_rover_path && obj.threat_level === 'high' && obj.distance_m <= stop_dist && obj.confidence >= 0.5) {
            return true;
        }
    }
    return false;
}


var run_mission = function (rover) {
    if (rover.robot_data.is_armed) {
        let nav_tuning = rover.nav_tuning || {};

        // ----- Blocked-path fallback delivery -----
        // Two sources can trigger fallback delivery:
        //   1. RealSense sees a high-threat object continuously in-path for rs_block_timeout_ms.
        //   2. avoid_object has been running continuously for avoidance_timeout_ms without clearing —
        //      meaning the rover has been spinning but never found a way through.
        if (!rover.mission.package_delivered && !rover.mission.finished_package_yaw) {
            let block_timeout = (nav_tuning.rs_block_timeout_ms) || 10000;
            let path_blocked = is_realsense_path_blocked(rover);

            if (rover.mission.avoidance_timed_out && !rover.mission.realsense_blocked_since) {
                // Avoidance exhausted — skip the rs_block countdown and fire immediately.
                rover.mission.realsense_blocked_since = Date.now() - block_timeout;
                path_blocked = true;
            }

            if (path_blocked) {
                if (!rover.mission.realsense_blocked_since) {
                    rover.mission.realsense_blocked_since = Date.now();
                }
                if (Date.now() - rover.mission.realsense_blocked_since >= block_timeout) {
                    // Find the last waypoint the rover successfully reached
                    let last_seq = rover.mission.current_mission_seq - 1;
                    let last_waypoint = null;
                    for (let i = 0; i < rover.mission.waypoints.length; i++) {
                        if (rover.mission.waypoints[i].seq === last_seq &&
                            rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
                            last_waypoint = rover.mission.waypoints[i];
                            break;
                        }
                    }
                    if (last_waypoint && !rover.mission.package_delivery_yaw) {
                        rover.mission.package_delivery_yaw = rover.get_bearing(
                            rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                            last_waypoint.lat, last_waypoint.lng
                        );
                    }
                    rover.mission.current_mission_seq = rover.mission.mission_count;
                    rover.mission.realsense_blocked_since = null;
                    let reason = rover.mission.avoidance_timed_out ? 'avoidance timeout' : ('blocked ' + block_timeout + 'ms');
                    rover.mission.avoidance_timed_out = false;
                    rover.mission.path_clear = true;
                    rover.logs.run_mission.log(rover, 'Fallback delivery (' + reason + '): facing waypoint ' + last_seq);
                }
            } else {
                rover.mission.realsense_blocked_since = null;
            }
        }
        // ----- end blocked-path fallback -----

        if (rover.mission.path_clear) {

            if (!rover.mission.pause_mission) {
                //run_mission command.....................
                let rover_heading = rover.get_heading(rover);
                let motor_speed_cmd = 0;

                if (!rover.mission.nav_accuracy) {
                    rover.mission.nav_accuracy = {
                        waypoint_seq: null,
                        inside_radius_count: 0,
                        required_inside_radius_count: 3
                    };
                }

                if (!rover.mission.nav_control) {
                    rover.mission.nav_control = {
                        waypoint_seq: null,
                        last_two_wheel_steering_deg: 0,
                        mission_yaw_active: false,
                        mission_yaw_aligned_count: 0,
                        sidewalk_seeking: false
                    };
                }




                //What is the next waypoint?
                let waypoint = { seq: null, latitude: null, longitude: null };

                if (rover.mission.package_delivered) {
                    //reverse through waypoints to return to dock after delivery
                    for (let i = rover.mission.waypoints.length - 1; i >= 0; i--) {

                        if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {

                            waypoint.seq = rover.mission.waypoints[i].seq;
                            waypoint.latitude = rover.mission.waypoints[i].lat;
                            waypoint.longitude = rover.mission.waypoints[i].lng;

                            if (waypoint.latitude == 0 || waypoint.longitude == 0) {
                                rover.mission.current_mission_seq -= 1;
                                console.log("Skipping invalid waypoint with lat/lng of 0,0");
                            }


                        }

                    }
                } else {
                    for (let i = 0; i < rover.mission.waypoints.length; i++) {

                        if (rover.mission.waypoints[i].seq == 0 && rover.mission.current_mission_seq == 0) {
                            //Skip lauch location
                            rover.mission.current_mission_seq += 1;
                        }
                        else if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {

                            waypoint.seq = rover.mission.waypoints[i].seq;
                            waypoint.latitude = rover.mission.waypoints[i].lat;
                            waypoint.longitude = rover.mission.waypoints[i].lng;

                            if (waypoint.latitude == 0 || waypoint.longitude == 0) {
                                rover.mission.current_mission_seq += 1;
                                console.log("Skipping invalid waypoint with lat/lng of 0,0");
                            }
                        }

                    }
                }



                if (waypoint.latitude && waypoint.longitude) {

                    //What is the distance to the next waypoint?
                    let distance_to_waypoint_meters = rover.gps_distance(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude) * 1000;
                    console.log("Distance to waypoint (meters): " + distance_to_waypoint_meters);

                    //Adaptive acceptance radius based on GPS quality + current speed command
                    let gps_error_m = 0;
                    if (rover.robot_data.GPS_RAW_INT && rover.robot_data.GPS_RAW_INT.eph) {
                        gps_error_m = rover.robot_data.GPS_RAW_INT.eph / 100;
                    } else if (rover.robot_data.gps_hdop) {
                        gps_error_m = rover.robot_data.gps_hdop * 0.5;
                    }

                    let speed_factor_m = Math.min(0.5, Math.abs(rover.motor.last_motor_speed_cmd || 0) / 400);
                    let adaptive_arrival_radius_m = 0.5 + Math.min(1.5, Math.max(0, gps_error_m * 0.5)) + speed_factor_m;
                    adaptive_arrival_radius_m = Math.max(0.5, Math.min(1.0, adaptive_arrival_radius_m));

                    //Require being inside arrival radius for multiple cycles to reduce GPS jitter false positives
                    if (rover.mission.nav_accuracy.waypoint_seq !== waypoint.seq) {
                        rover.mission.nav_accuracy.waypoint_seq = waypoint.seq;
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    if (rover.mission.nav_control.waypoint_seq !== waypoint.seq) {
                        rover.mission.nav_control.waypoint_seq = waypoint.seq;
                        rover.mission.nav_control.last_two_wheel_steering_deg = 0;
                        rover.mission.nav_control.mission_yaw_active = false;
                        rover.mission.nav_control.mission_yaw_aligned_count = 0;
                        rover.mission.nav_control.sidewalk_seeking = false;
                    }

                    if (distance_to_waypoint_meters <= adaptive_arrival_radius_m) {
                        rover.mission.nav_accuracy.inside_radius_count += 1;
                    } else {
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    //At waypoint: advance sequence immediately to avoid GPS jitter causing yaw direction flips
                    if (rover.mission.nav_accuracy.inside_radius_count >= rover.mission.nav_accuracy.required_inside_radius_count) {
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                        rover.logs.run_mission.log(rover, "waypoint reached: " + rover.mission.current_mission_seq);

                        // Look ahead to the next waypoint to decide if a 4-wheel stop is needed
                        let next_seq = rover.mission.package_delivered
                            ? rover.mission.current_mission_seq - 1
                            : rover.mission.current_mission_seq + 1;

                        let next_waypoint = null;
                        for (let i = 0; i < rover.mission.waypoints.length; i++) {
                            if (rover.mission.waypoints[i].seq === next_seq &&
                                rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
                                next_waypoint = rover.mission.waypoints[i];
                                break;
                            }
                        }

                        let needs_stop = true;
                        if (next_waypoint) {
                            let next_bearing = rover.get_bearing(
                                rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                                next_waypoint.lat, next_waypoint.lng
                            );
                            let next_yaw_error = (next_bearing - rover_heading + 360) % 360;
                            if (next_yaw_error > 180) next_yaw_error -= 360;
                            needs_stop = Math.abs(next_yaw_error) > nav_tuning.mission_yaw_start_deg;
                        }

                        // Advance the sequence
                        if (rover.mission.package_delivered) {
                            rover.mission.current_mission_seq -= 1;
                        } else {
                            rover.mission.current_mission_seq += 1;
                        }

                        if (needs_stop || !next_waypoint) {
                            // 4-wheel turn required (or no next waypoint): stop and let yaw logic handle next tick
                            rover.move_rover(rover, 1, 0, "run_mission waypoint_reached");
                            rover.move_rover(rover, 2, 0, "run_mission waypoint_reached");
                            rover.move_rover(rover, 3, 0, "run_mission waypoint_reached");
                            rover.move_rover(rover, 4, 0, "run_mission waypoint_reached");
                            return;
                        }

                        // Drive-through: update waypoint target in-place and keep rolling
                        waypoint.seq = next_waypoint.seq;
                        waypoint.latitude = next_waypoint.lat;
                        waypoint.longitude = next_waypoint.lng;
                        distance_to_waypoint_meters = rover.gps_distance(
                            rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                            waypoint.latitude, waypoint.longitude
                        ) * 1000;
                        rover.mission.nav_accuracy.waypoint_seq = next_waypoint.seq;
                        rover.logs.run_mission.log(rover, "drive-through to waypoint: " + next_waypoint.seq);
                    }

                    //What is heading of the next waypoint?
                    let waypoint_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
                    //console.log("Next waypoint bearing: " + waypoint_bearing + " Rover heading: " + rover_heading);

                    //yaw rover towards waypoint
                    let yaw_to_waypoint = (waypoint_bearing - rover_heading + 360) % 360;
                    if (yaw_to_waypoint > 180) yaw_to_waypoint -= 360;
                    rover.robot_data.yaw_to_waypoint = yaw_to_waypoint;



                    //Reduce speed target when heading error or proximity is high
                    let yaw_abs = Math.abs(rover.robot_data.yaw_to_waypoint);
                    let yaw_speed_scale = 1;
                    if (yaw_abs > 35) {
                        yaw_speed_scale = 0.35;
                    } else if (yaw_abs > 25) {
                        yaw_speed_scale = 0.5;
                    } else if (yaw_abs > 15) {
                        yaw_speed_scale = 0.7;
                    } else if (yaw_abs > 8) {
                        yaw_speed_scale = 0.85;
                    }

                    let distance_speed_scale = 1;
                    if (distance_to_waypoint_meters < 1.5) {
                        distance_speed_scale = 0.3;
                    } else if (distance_to_waypoint_meters < 3) {
                        distance_speed_scale = 0.5;
                    } else if (distance_to_waypoint_meters < 6) {
                        distance_speed_scale = 0.75;
                    }

                    let target_speed_cmd = Math.max(35, Math.round(200 * Math.min(yaw_speed_scale, distance_speed_scale)));

                    let mission_yaw_abs = Math.abs(rover.robot_data.yaw_to_waypoint);
                    let mission_yaw_start_deg = nav_tuning.mission_yaw_start_deg;
                    let mission_yaw_stop_deg = nav_tuning.mission_yaw_stop_deg;
                    let mission_yaw_should_run = rover.mission.nav_control.mission_yaw_active
                        ? mission_yaw_abs > mission_yaw_stop_deg || rover.mission.nav_control.mission_yaw_aligned_count < nav_tuning.mission_yaw_stable_cycles
                        : mission_yaw_abs > mission_yaw_start_deg;

                    if (mission_yaw_should_run) {
                        rover.mission.nav_control.mission_yaw_active = true;

                        if (mission_yaw_abs <= mission_yaw_stop_deg) {
                            rover.mission.nav_control.mission_yaw_aligned_count += 1;
                            rover.move_rover(rover, 1, 0, "run_mission yaw_hold");
                            rover.move_rover(rover, 2, 0, "run_mission yaw_hold");
                            rover.move_rover(rover, 3, 0, "run_mission yaw_hold");
                            rover.move_rover(rover, 4, 0, "run_mission yaw_hold");
                        }
                        else if (rover.motor.current_steering_type != "four_wheels") {
                            rover.mission.nav_control.mission_yaw_aligned_count = 0;
                            rover.motor.current_steering_type = "four_wheels";
                            rover.mission.pause_mission = true;
                            //stop rover
                            rover.move_rover(rover, 1, 0, "pause_mission");
                            rover.move_rover(rover, 2, 0, "pause_mission");
                            rover.move_rover(rover, 3, 0, "pause_mission");
                            rover.move_rover(rover, 4, 0, "pause_mission");
                            setTimeout(() => {
                                rover.mission.pause_mission = false;

                            }, 500);

                        }
                        else {
                            rover.mission.nav_control.mission_yaw_aligned_count = 0;

                            let yaw_speed_cmd = Math.round(mission_yaw_abs * nav_tuning.mission_yaw_gain);
                            if (mission_yaw_abs < nav_tuning.mission_yaw_brake_window_deg) {
                                let brake_scale = Math.max(0.35, mission_yaw_abs / nav_tuning.mission_yaw_brake_window_deg);
                                yaw_speed_cmd = Math.round(yaw_speed_cmd * brake_scale);
                            }

                            yaw_speed_cmd = Math.max(nav_tuning.mission_yaw_min_speed, yaw_speed_cmd);
                            yaw_speed_cmd = Math.min(nav_tuning.mission_yaw_max_speed, yaw_speed_cmd);

                            rover.yaw_rover(rover, rover.robot_data.yaw_to_waypoint, yaw_speed_cmd);
                        }
                    }
                    else {
                        rover.mission.nav_control.mission_yaw_active = false;
                        rover.mission.nav_control.mission_yaw_aligned_count = 0;


                        if (rover.motor.current_steering_type == "four_wheels") {
                            rover.servo_send_command(rover, 11, 1500, true);
                            rover.servo_send_command(rover, 13, 1500, true);
                            rover.servo_send_command(rover, 12, 1500, true);
                            rover.servo_send_command(rover, 14, 1500, true);

                            //stop the rover	

                            rover.move_rover(rover, 1, 0, "run_mission");
                            rover.move_rover(rover, 2, 0, "run_mission");
                            rover.move_rover(rover, 3, 0, "run_mission");
                            rover.move_rover(rover, 4, 0, "run_mission");

                            if (rover.servos.motor_front_driver.set_pwm > 1400 && rover.servos.motor_front_driver.set_pwm < 1600 &&
                                rover.servos.motor_back_driver.set_pwm > 1400 && rover.servos.motor_back_driver.set_pwm < 1600 &&
                                rover.servos.motor_front_passenger.set_pwm > 1400 && rover.servos.motor_front_passenger.set_pwm < 1600 &&
                                rover.servos.motor_back_passenger.set_pwm > 1400 && rover.servos.motor_back_passenger.set_pwm < 1600) {
                                rover.motor.current_steering_type = "two_wheels";
                                rover.mission.nav_control.last_two_wheel_steering_deg = 0;
                            }
                        } else if (rover.motor.current_steering_type == "two_wheels") {



                            //move forward towards waypoint
                            if (distance_to_waypoint_meters > adaptive_arrival_radius_m) {

                                if (rover.rplidar.avoid_object) {
                                    if (rover.zones[10].light == "yellow" && rover.zones[10].distance_mm) {
                                        motor_speed_cmd = Math.min(target_speed_cmd, rover.calc_speed_based_on_distance(rover.zones[10], rover.zones[10].distance_mm));
                                    }
                                    else if (rover.zones[11].light == "yellow" && rover.zones[11].distance_mm) {
                                        motor_speed_cmd = Math.min(target_speed_cmd, rover.calc_speed_based_on_distance(rover.zones[11], rover.zones[11].distance_mm));
                                    }
                                    else {
                                        motor_speed_cmd = rover.throttle_up(rover, target_speed_cmd);
                                    }
                                }
                                else {
                                    motor_speed_cmd = rover.throttle_up(rover, target_speed_cmd);
                                }
                            }
                            else if (distance_to_waypoint_meters <= adaptive_arrival_radius_m) {
                                motor_speed_cmd = 0;
                            }

                            let two_wheel_yaw_abs = Math.abs(yaw_to_waypoint);
                            if (two_wheel_yaw_abs > nav_tuning.two_wheel_slowdown_yaw_high_deg) {
                                motor_speed_cmd = Math.min(motor_speed_cmd, nav_tuning.two_wheel_speed_limit_high);
                            } else if (two_wheel_yaw_abs > nav_tuning.two_wheel_slowdown_yaw_medium_deg) {
                                motor_speed_cmd = Math.min(motor_speed_cmd, nav_tuning.two_wheel_speed_limit_medium);
                            } else if (two_wheel_yaw_abs > nav_tuning.two_wheel_slowdown_yaw_low_deg) {
                                motor_speed_cmd = Math.min(motor_speed_cmd, nav_tuning.two_wheel_speed_limit_low);
                            }

                            if (Math.abs(rover.robot_data.yaw_to_waypoint) > 25) {

                                //currently not being used lower yaw to waypoint value to enable
                                var steering_and_rpm = rover.calc_steering_and_rpm(rover, rover.robot_data.yaw_to_waypoint / 3, motor_speed_cmd);

                                //console.log("Steering Angles: ", steering_and_rpm.servo_angles_deg);
                                //console.log("Motor RPMs: ", steering_and_rpm.motor_rpm);

                                rover.servo_send_command(rover, 11, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
                                rover.servo_send_command(rover, 13, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
                                rover.servo_send_command(rover, 12, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
                                rover.servo_send_command(rover, 14, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);

                                //All wheel drive logic

                                //front passenger
                                rover.move_rover(rover, 1, steering_and_rpm.motor_rpm.front_passenger, "run_mission all wheel");
                                //rear passenger side
                                rover.move_rover(rover, 2, steering_and_rpm.motor_rpm.back_passenger, "run_mission all wheel");
                                //front driver side
                                rover.move_rover(rover, 3, steering_and_rpm.motor_rpm.front_driver, "run_mission all wheel");
                                //rear driver side
                                rover.move_rover(rover, 4, steering_and_rpm.motor_rpm.back_driver, "run_mission all wheel");

                            } else {

                                //steer towards waypoint complete, move forward

                                // Sidewalk recovery: if rover is significantly offset from sidewalk
                                // center, enter seeking mode (hysteresis) to boost vision influence.
                                let seek_cfg = rover.realsense && rover.realsense.vision;
                                let seek_detection = rover.realsense && rover.realsense.path_detection;
                                let seek_offset_abs = seek_detection && typeof seek_detection.offset_meters === 'number'
                                    ? Math.abs(seek_detection.offset_meters) : 0;
                                let seek_enter_m = seek_cfg && typeof seek_cfg.sidewalk_seek_offset_m === 'number' ? seek_cfg.sidewalk_seek_offset_m : 0.1;
                                let seek_exit_m  = seek_cfg && typeof seek_cfg.sidewalk_seek_exit_m  === 'number' ? seek_cfg.sidewalk_seek_exit_m  : 0.08;

                                let history_analysis = get_history_analysis(
                                    rover.realsense && rover.realsense.path_detection_history,
                                    seek_cfg
                                );

                                if (!rover.mission.nav_control.sidewalk_seeking) {
                                    if (seek_offset_abs > seek_enter_m || history_analysis.sustained_seeking) {
                                        rover.mission.nav_control.sidewalk_seeking = true;
                                    }
                                } else {
                                    if (seek_offset_abs < seek_exit_m && !history_analysis.sustained_seeking) {
                                        rover.mission.nav_control.sidewalk_seeking = false;
                                    }
                                }
                                let sidewalk_seeking = rover.mission.nav_control.sidewalk_seeking;

                                let adjusted_nav = get_adjusted_nav_target(rover, waypoint.latitude, waypoint.longitude, waypoint_bearing, distance_to_waypoint_meters, history_analysis, sidewalk_seeking);
                                let nav_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, adjusted_nav.latitude, adjusted_nav.longitude);
                                let nav_yaw = (nav_bearing - rover_heading + 360) % 360;
                                if (nav_yaw > 180) nav_yaw -= 360;

                                let crosstrack_bias_deg = get_gps_crosstrack_bias_deg(rover, adjusted_nav.latitude, adjusted_nav.longitude);

                                // Fade crosstrack to zero near waypoint; GPS owns the turn
                                let vision_scale = distance_to_waypoint_meters < 3.0
                                    ? clamp((distance_to_waypoint_meters - 1.0) / 2.0, 0, 1)
                                    : 1.0;

                                let steering_target_deg = (nav_yaw * nav_tuning.two_wheel_steering_gain) + (crosstrack_bias_deg * vision_scale);
                                let steering_target_abs = Math.abs(steering_target_deg);
                                if (steering_target_abs < nav_tuning.two_wheel_steering_deadband_deg) {
                                    steering_target_deg = 0;
                                } else {
                                    steering_target_deg = Math.sign(steering_target_deg) * Math.min(nav_tuning.two_wheel_max_steering_deg, steering_target_abs);
                                }

                                let steering_delta_deg = steering_target_deg - rover.mission.nav_control.last_two_wheel_steering_deg;
                                if (steering_delta_deg > nav_tuning.two_wheel_max_steering_delta_deg) steering_delta_deg = nav_tuning.two_wheel_max_steering_delta_deg;
                                if (steering_delta_deg < nav_tuning.two_wheel_max_steering_delta_deg * -1) steering_delta_deg = nav_tuning.two_wheel_max_steering_delta_deg * -1;

                                let commanded_steering_deg = rover.mission.nav_control.last_two_wheel_steering_deg + steering_delta_deg;
                                rover.mission.nav_control.last_two_wheel_steering_deg = commanded_steering_deg;

                                var steer_pwm = rover.angle_to_pwm(commanded_steering_deg);
                                rover.servo_send_command(rover, 12, 1500, false);
                                rover.servo_send_command(rover, 14, 1500, false);
                                rover.servo_send_command(rover, 11, steer_pwm.servo1, true);
                                rover.servo_send_command(rover, 13, steer_pwm.servo2, true);

                                rover.move_rover(rover, 1, motor_speed_cmd * -1, "run_mission 2 wheel");
                                rover.move_rover(rover, 4, motor_speed_cmd, "run_mission 2 wheel");
                                rover.move_rover(rover, 3, motor_speed_cmd, "run_mission 2 wheel");
                                rover.move_rover(rover, 2, motor_speed_cmd * -1, "run_mission 2 wheel");
                            }

                        }
                    }

                }
                else {
                    if (!rover.mission.package_delivered) {
                        rover.yaw_rover_for_package_delivery(rover);
                        rover.logs.run_mission.log(rover, "At drop-off: yaw_rover_for_package_delivery");
                    }
                    else {
                        console.log("Mission Finished. No waypoint data available.");
                        rover.logs.run_mission.log(rover, "Mission Finished. No waypoint data available.");
                        clearInterval(rover.mission.mission_interval);
                    }
                }
            }
            else {
                console.log("Mission paused.");
                rover.logs.run_mission.log(rover, "Mission paused.");
            }

        }
    } else {
        //console.log("Rover is disarmed.");
        rover.logs.run_mission.log(rover, "Rover is disarmed");
    };

}


module.exports = run_mission;