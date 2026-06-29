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

        //edge_left_x_m should always be -x, and edge_right_x_m should always be +x
        // edge_right_x is unknown
        if (!edge_right_x) {
            edge_right_x = edge_left_x + 1.0;
        }

        // edge_left_x is unknown
        if (!edge_left_x) {
            edge_left_x = edge_right_x - 1.0;
        }


        // if one Y is unknown, use the other
        if (!edge_left_y) { edge_left_y = edge_right_y };
        if (!edge_right_y) { edge_right_y = edge_left_y };

        //STEERING...................................................................
        // Compute angle to each edge individually so Y-depth is captured — when edges are
        // symmetric in X (e.g. el=-0.5, er=0.5) the centerline approach gives 0° regardless
        // of Y asymmetry, missing S-turn curvature. Averaging per-edge angles fixes this:
        // a closer edge (smaller Y) contributes a larger angle, pulling the average toward
        // that side and steering Noah through the curve.
        var angle_to_left_edge = Math.atan2(edge_left_x, edge_left_y) * (180 / Math.PI);
        var angle_to_right_edge = Math.atan2(edge_right_x, edge_right_y) * (180 / Math.PI);
        white_rabbit.motor.steering_angle_deg = (angle_to_left_edge + angle_to_right_edge) / 2;

        //motor speed command............................... 
        var motor_speed_cmd = (white_rabbit.realsense.path_detection.edge_left_conf + white_rabbit.realsense.path_detection.edge_right_conf) / 2 * 100;

        //Motor is moving
        white_rabbit.motor.moving = true;

        var steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, white_rabbit.motor.steering_angle_deg, motor_speed_cmd);

        // Rear wheels fade smoothly toward neutral as angle drops below 10° — no snap on
        // mode transition. At 10° rear wheels are at full Ackermann; at 0° they are centered.
        var rear_blend = Math.min(1.0, Math.abs(white_rabbit.motor.steering_angle_deg) / 10.0);
        var back_driver_pwm    = white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2;
        var back_passenger_pwm = white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1;

        white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, false);
        white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, false);
        white_rabbit.servo_send_command(white_rabbit, 12, Math.round(1500 + (back_driver_pwm    - 1500) * rear_blend), false);
        white_rabbit.servo_send_command(white_rabbit, 14, Math.round(1500 + (back_passenger_pwm - 1500) * rear_blend), false);

        if (Math.abs(white_rabbit.motor.steering_angle_deg) < 10) {
            // Small angle: flat motor speeds, no differential (reduces overcorrection)
            white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "follow_the_yellow_brick_road");
            white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "follow_the_yellow_brick_road");
            white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "follow_the_yellow_brick_road");
            white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "follow_the_yellow_brick_road");
        } else {
            // Larger angle: Ackermann motor differential for sharper turns
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
    }


    //NO EDGES DETECTED.........................................................
    if (!white_rabbit.motor.moving) {
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