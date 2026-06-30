var follow_the_yellow_brick_road = function (white_rabbit) {

    var _log = white_rabbit.logs && white_rabbit.logs.follow_the_yelow_bick_road;

    // Detect RC takeover and log it once per transition
    var _rc_active = !!(white_rabbit.flight_data &&
        (white_rabbit.flight_data.manual_intervention ||
         white_rabbit.flight_data.control_type === 'manual'));
    if (_rc_active && !follow_the_yellow_brick_road._last_rc) {
        if (_log) _log.log(white_rabbit, {
            event: 'RC_TAKEOVER',
            lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
            lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude,
            heading: white_rabbit.get_heading(white_rabbit),
            seq: white_rabbit.mission.current_mission_seq
        });
    }
    follow_the_yellow_brick_road._last_rc = _rc_active;

    //confidence thresholds for path detection
    //white_rabbit.realsense.path_detection.edge_left_conf
    //white_rabbit.realsense.path_detection.edge_right_conf

    //Edge X and Y coordinates in meters
    //white_rabbit.realsense.path_detection.edge_left_x_m
    //white_rabbit.realsense.path_detection.edge_right_x_m
    //white_rabbit.realsense.path_detection.edge_left_y_m
    //white_rabbit.realsense.path_detection.edge_right_y_m

    //EDGES.........................................................
    //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).
    var edge_left_x = white_rabbit.realsense.path_detection.edge_left_x_m;
    var edge_right_x = white_rabbit.realsense.path_detection.edge_right_x_m;
    var edge_left_y = white_rabbit.realsense.path_detection.edge_left_y_m;
    var edge_right_y = white_rabbit.realsense.path_detection.edge_right_y_m;

    if (edge_left_x || edge_right_x) {


        if (!white_rabbit.motor.moving) {
            //reset servos.................
            white_rabbit.servo_send_command(white_rabbit, 11, 1500, true);
            white_rabbit.servo_send_command(white_rabbit, 13, 1500, true);
            white_rabbit.servo_send_command(white_rabbit, 12, 1500, true);
            white_rabbit.servo_send_command(white_rabbit, 14, 1500, true);

            white_rabbit.motor.moving = true;

            white_rabbit.mission.pause_mission = true;
            setTimeout(() => {
                white_rabbit.mission.pause_mission = false;

            }, 1000);


        }

        // Always update last-known when confidence is good — even during startup pause
        var _pd = white_rabbit.realsense.path_detection;
        if (_pd.edge_left_conf > 0.5 && edge_left_x) {
            _pd.last_known_edge_left_x_m = edge_left_x;
            _pd.last_known_edge_left_y_m = edge_left_y;
        }
        if (_pd.edge_right_conf > 0.5 && edge_right_x) {
            _pd.last_known_edge_right_x_m = edge_right_x;
            _pd.last_known_edge_right_y_m = edge_right_y;
        }

        // Track which edges are falling back to last-known (for logging)
        var _lk_left  = !edge_left_x  && !!_pd.last_known_edge_left_x_m;
        var _lk_right = !edge_right_x && !!_pd.last_known_edge_right_x_m;

        // Fall back to last-known only if the value was actually saved (guard against undefined → NaN)
        if (!edge_right_x && _pd.last_known_edge_right_x_m) edge_right_x = _pd.last_known_edge_right_x_m;
        if (!edge_right_y && _pd.last_known_edge_right_y_m) edge_right_y = _pd.last_known_edge_right_y_m;
        if (!edge_left_x  && _pd.last_known_edge_left_x_m)  edge_left_x  = _pd.last_known_edge_left_x_m;
        if (!edge_left_y  && _pd.last_known_edge_left_y_m)  edge_left_y  = _pd.last_known_edge_left_y_m;

        if (!white_rabbit.mission.pause_mission) {

            //Motor speed..................
            var motor_speed_cmd = (white_rabbit.realsense.path_detection.edge_left_conf + white_rabbit.realsense.path_detection.edge_right_conf) / 2 * 100;

            //STEERING...................................................................
            //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).


            // var centerline_x = (edge_left_x + edge_right_x) / 2;
            // var centerline_y = (edge_left_y + edge_right_y) / 2;

            // white_rabbit.motor.steering_angle_deg = Math.atan2(centerline_x, centerline_y) * (180 / Math.PI);


            // Steering formula — three cases:
            // Both edges: cross-coupled atan2 (original formula, works well on straights/gentle curves)
            // One edge only: offset formula — steer to hold edge_side_offset_m lateral gap from the
            //   visible edge. Prevents the atan2(x, 0) = ±90° blow-up when the other edge has no
            //   data at all (no live detection AND no last-known yet, e.g. at path startup).
            var _side_m = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_side_offset_m) || 0.5;
            var _have_left  = !!edge_left_x;
            var _have_right = !!edge_right_x;
            var _steer_mode;
            if (_have_left && _have_right) {
                var angle_to_left_edge  = Math.atan2(edge_left_x,          edge_right_y) * (180 / Math.PI);
                var angle_to_right_edge = Math.atan2(edge_right_x,         edge_left_y)  * (180 / Math.PI);
                white_rabbit.motor.steering_angle_deg = (angle_to_left_edge + angle_to_right_edge) / 2;
                _steer_mode = 'dual';
            } else if (_have_left) {
                // Hold _side_m to the right of the left edge
                white_rabbit.motor.steering_angle_deg = Math.atan2(edge_left_x + _side_m, edge_left_y) * (180 / Math.PI);
                _steer_mode = 'left_only';
            } else if (_have_right) {
                // Hold _side_m to the left of the right edge
                white_rabbit.motor.steering_angle_deg = Math.atan2(edge_right_x - _side_m, edge_right_y) * (180 / Math.PI);
                _steer_mode = 'right_only';
            } else {
                white_rabbit.motor.steering_angle_deg = 0;
                _steer_mode = 'none';
            }

            //adjust steering tune based on angle.......
            var abs_angle = Math.abs(white_rabbit.motor.steering_angle_deg);
            var steering_tune;
            if      (abs_angle < 9)   steering_tune = 0.50;
            else if (abs_angle < 9.5) steering_tune = 0.55;
            else if (abs_angle < 10)  steering_tune = 0.60;
            else if (abs_angle < 11)  steering_tune = 0.65;
            else if (abs_angle < 13)  steering_tune = 0.70;
            else if (abs_angle < 14)  steering_tune = 0.75;
            else if (abs_angle < 15)  steering_tune = 0.80;
            else if (abs_angle < 16)  steering_tune = 0.85;
            else if (abs_angle < 17)  steering_tune = 0.90;
            else if (abs_angle < 18)  steering_tune = 0.95;
            else                      steering_tune = 1.00;





            var _angle_raw = white_rabbit.motor.steering_angle_deg;
            white_rabbit.motor.steering_angle_deg = white_rabbit.motor.steering_angle_deg * steering_tune;

            //Motor speed..................
            var motor_speed_cmd = (white_rabbit.realsense.path_detection.edge_left_conf + white_rabbit.realsense.path_detection.edge_right_conf) / 2 * 100;

            // Speed-based steering damper: at higher motor speed, soften the steering
            // correction so Noah doesn't overcorrect on the straights. At low speed
            // (low confidence / tight curve), full steering authority is preserved.
            // speed_cmd ~50 → speed_tune ~0.85, speed_cmd ~100 → speed_tune ~0.70
            var speed_steer_reduction = 0.30;
            var speed_tune = 1.0 - speed_steer_reduction * (motor_speed_cmd / 100);
            white_rabbit.motor.steering_angle_deg = white_rabbit.motor.steering_angle_deg * speed_tune;

            // Rate limiter: cap how fast the steering command can change per 250ms cycle.
            // Prevents reacquisition spikes (e.g. 27° in one tick) from reaching the wheels.
            var _max_delta_deg = 8;
            var _prev_angle = follow_the_yellow_brick_road._prev_angle || 0;
            var _delta = white_rabbit.motor.steering_angle_deg - _prev_angle;
            if (_delta >  _max_delta_deg) white_rabbit.motor.steering_angle_deg = _prev_angle + _max_delta_deg;
            if (_delta < -_max_delta_deg) white_rabbit.motor.steering_angle_deg = _prev_angle - _max_delta_deg;
            follow_the_yellow_brick_road._prev_angle = white_rabbit.motor.steering_angle_deg;

            if (_log) _log.log(white_rabbit, {
                event: 'steer',
                lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude,
                hdg: white_rabbit.get_heading(white_rabbit),
                el_x: edge_left_x,  el_y: edge_left_y,  el_c: _pd.edge_left_conf,  el_lk: _lk_left,
                er_x: edge_right_x, er_y: edge_right_y, er_c: _pd.edge_right_conf, er_lk: _lk_right,
                angle_raw: Math.round(_angle_raw * 10) / 10,
                angle: Math.round(white_rabbit.motor.steering_angle_deg * 10) / 10,
                a_tune: steering_tune,
                s_tune: Math.round(speed_tune * 100) / 100,
                spd: Math.round(motor_speed_cmd),
                mode: _steer_mode,
                seq: white_rabbit.mission.current_mission_seq,
                rc: _rc_active
            });
            var steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, white_rabbit.motor.steering_angle_deg, motor_speed_cmd);


            white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
            white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
            white_rabbit.servo_send_command(white_rabbit, 12, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
            white_rabbit.servo_send_command(white_rabbit, 14, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);


            //MOTOR SPEED...................................................................
            //motor speed command is based on confidence of path detection.  If confidence is low, the speed is reduced to allow for more time to detect the path.
            white_rabbit.motor.moving = true;
            white_rabbit.move_white_rabbit(white_rabbit, 1, steering_and_rpm.motor_rpm.front_passenger, "follow_the_yellow_brick_road");
            white_rabbit.move_white_rabbit(white_rabbit, 2, steering_and_rpm.motor_rpm.back_passenger, "follow_the_yellow_brick_road");
            white_rabbit.move_white_rabbit(white_rabbit, 3, steering_and_rpm.motor_rpm.front_driver, "follow_the_yellow_brick_road");
            white_rabbit.move_white_rabbit(white_rabbit, 4, steering_and_rpm.motor_rpm.back_driver, "follow_the_yellow_brick_road");
        }
    } else if (white_rabbit.motor.moving) {
        if (_log) _log.log(white_rabbit, {
            event: 'EDGES_LOST',
            lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
            lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude,
            hdg: white_rabbit.get_heading(white_rabbit),
            seq: white_rabbit.mission.current_mission_seq,
            rc: _rc_active
        });
        follow_the_yellow_brick_road._prev_angle = 0;
        //stop the motors.............
        white_rabbit.motor.moving = false;
        white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "follow_the_yellow_brick_road");
        white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "follow_the_yellow_brick_road");
        white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "follow_the_yellow_brick_road");
        white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "follow_the_yellow_brick_road");

        white_rabbit.mission.pause_mission = true;
        setTimeout(() => {
            white_rabbit.mission.pause_mission = false;

        }, 1000);
    }


    //NO EDGES DETECTED.........................................................
    if (!white_rabbit.motor.moving) {

        if (!white_rabbit.mission.pause_mission) {

            // Yaw Noah towards the next waypoint to scan for edges again.
            var _lat = white_rabbit.robot_data.robot_latitude;
            var _lng = white_rabbit.robot_data.robot_longitude;
            var _heading = white_rabbit.get_heading(white_rabbit);
            var _seq = white_rabbit.mission.current_mission_seq;
            var _wp = null;

            for (var i = 0; i < white_rabbit.mission.waypoints.length; i++) {
                if (white_rabbit.mission.waypoints[i].seq === _seq &&
                    white_rabbit.mission.waypoints[i].lat &&
                    white_rabbit.mission.waypoints[i].lng) {
                    _wp = white_rabbit.mission.waypoints[i];
                    break;
                }
            }

            if (_wp && _lat && _lng && typeof _heading === 'number') {
                var _bearing = white_rabbit.get_bearing(_lat, _lng, _wp.lat, _wp.lng);
                var _yaw_error = ((_bearing - _heading + 540) % 360) - 180;
                if (Math.abs(_yaw_error) > 5) {
                    white_rabbit.yaw_white_rabbit(white_rabbit, _yaw_error, 20);
                }
            }
        }
    }


    //Waypoint Reached.........................................................
    if (white_rabbit.mission.current_mission_seq && white_rabbit.mission.waypoints.length > 0) {
        var _current_wp = white_rabbit.mission.waypoints.find(wp => wp.seq === white_rabbit.mission.current_mission_seq);
        if (white_rabbit.mission.package_delivered) {

            if (_current_wp && _current_wp.lat && _current_wp.lng) {

                if (white_rabbit.robot_data.robot_latitude && white_rabbit.robot_data.robot_longitude) {
                    var _distance_to_wp = white_rabbit.gps_distance(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude, _current_wp.lat, _current_wp.lng) * 1000;
                    if (_distance_to_wp < 1.0) { // 1 meter threshold for waypoint reached
                        white_rabbit.mission.current_mission_seq--;
                    }
                }
            }

        } else {

            if (_current_wp && _current_wp.lat && _current_wp.lng) {

                if (white_rabbit.robot_data.robot_latitude && white_rabbit.robot_data.robot_longitude) {
                    var _distance_to_wp = white_rabbit.gps_distance(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude, _current_wp.lat, _current_wp.lng) * 1000;
                    if (_distance_to_wp < 1.0) { // 1 meter threshold for waypoint reached
                        white_rabbit.mission.current_mission_seq++;
                    }
                }
            }
        }
    }



};
module.exports = follow_the_yellow_brick_road;