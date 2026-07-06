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

    //get the steering degree angle of the carrot, which noah will follow........
    //carrot() also sets white_rabbit.motor.carrot_has_edge (confidence-gated) below.
    white_rabbit.motor.steering_angle_deg = white_rabbit.carrot(white_rabbit);

    if (white_rabbit.motor.carrot_has_edge || 1 == 1) {



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



        if (!white_rabbit.mission.pause_mission) {

            //Motor speed..................
            var motor_speed_cmd = (white_rabbit.realsense.path_detection.edge_left_conf + white_rabbit.realsense.path_detection.edge_right_conf) / 2 * 100;



            if (_log) _log.log(white_rabbit, {
                event: 'steer',
                lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude,
                hdg: white_rabbit.get_heading(white_rabbit),
                el_x: white_rabbit.realsense.path_detection.edge_left_x_m, el_y: white_rabbit.realsense.path_detection.edge_left_y_m, el_c: white_rabbit.realsense.path_detection.edge_left_conf,
                er_x: white_rabbit.realsense.path_detection.edge_right_x_m, er_y: white_rabbit.realsense.path_detection.edge_right_y_m, er_c: white_rabbit.realsense.path_detection.edge_right_conf,
                turn_bias: Math.round(white_rabbit.motor.steering_turn_bias * 10) / 10,
                angle_raw: Math.round(white_rabbit.motor.steering_angle_raw * 10) / 10,
                angle: Math.round(white_rabbit.motor.steering_angle_deg * 10) / 10,
                a_tune: white_rabbit.motor.steering_tune,
                spd: Math.round(motor_speed_cmd),
                seq: white_rabbit.mission.current_mission_seq,
                rc: _rc_active
            });

            //Steering and RPM........................................
          
            var steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, white_rabbit.motor.steering_angle_deg, motor_speed_cmd);

            // Reported back so the RC edge-capture logger (radio_commands.js) can record what
            // Noah actually commanded during an autonomous (mission_mode) pass, instead of the
            // idle RC stick position.
            white_rabbit.motor.servo_angles_deg = steering_and_rpm.servo_angles_deg;
            white_rabbit.motor.speed_cmd = motor_speed_cmd;

            //Send steer command to Noah..............................
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
    // if (!white_rabbit.motor.moving) {

    //     if (!white_rabbit.mission.pause_mission) {

    //         // Yaw Noah towards the next waypoint to scan for edges again.
    //         var _wp = null;

    //         for (var i = 0; i < white_rabbit.mission.waypoints.length; i++) {
    //             if (white_rabbit.mission.waypoints[i].seq === white_rabbit.mission.current_mission_seq &&
    //                 white_rabbit.mission.waypoints[i].lat &&
    //                 white_rabbit.mission.waypoints[i].lng) {
    //                 _wp = white_rabbit.mission.waypoints[i];
    //                 break;
    //             }
    //         }

    //         if (_wp && white_rabbit.robot_data.robot_latitude && white_rabbit.robot_data.robot_longitude
    //             && typeof white_rabbit.get_heading(white_rabbit) === 'number') {
    //             var _bearing = white_rabbit.get_bearing(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude, _wp.lat, _wp.lng);
    //             var _yaw_error = ((_bearing - white_rabbit.get_heading(white_rabbit) + 540) % 360) - 180;
    //             if (Math.abs(_yaw_error) > 5) {
    //                 white_rabbit.yaw_white_rabbit(white_rabbit, _yaw_error, 20);
    //             }
    //         }
    //     }
    // }


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