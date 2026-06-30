var follow_the_yellow_brick_road = function (white_rabbit) {


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

        // Fall back to last-known only if the value was actually saved (guard against undefined → NaN)
        if (!edge_right_x && _pd.last_known_edge_right_x_m) edge_right_x = _pd.last_known_edge_right_x_m;
        if (!edge_right_y && _pd.last_known_edge_right_y_m) edge_right_y = _pd.last_known_edge_right_y_m;
        if (!edge_left_x  && _pd.last_known_edge_left_x_m)  edge_left_x  = _pd.last_known_edge_left_x_m;
        if (!edge_left_y  && _pd.last_known_edge_left_y_m)  edge_left_y  = _pd.last_known_edge_left_y_m;

        if (!white_rabbit.mission.pause_mission) {



            //STEERING...................................................................
            //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).


            // var centerline_x = (edge_left_x + edge_right_x) / 2;
            // var centerline_y = (edge_left_y + edge_right_y) / 2;

            // white_rabbit.motor.steering_angle_deg = Math.atan2(centerline_x, centerline_y) * (180 / Math.PI);


            var angle_to_left_edge = Math.atan2(edge_left_x, edge_right_y) * (180 / Math.PI);
            var angle_to_right_edge = Math.atan2(edge_right_x, edge_left_y) * (180 / Math.PI);
            white_rabbit.motor.steering_angle_deg = (angle_to_left_edge + angle_to_right_edge) / 2;

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





            white_rabbit.motor.steering_angle_deg = white_rabbit.motor.steering_angle_deg * steering_tune;

            //Motor speed..................
            var motor_speed_cmd = (white_rabbit.realsense.path_detection.edge_left_conf + white_rabbit.realsense.path_detection.edge_right_conf) / 2 * 100;
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