var run_mission = function (rover) {
    if (rover.robot_data.is_armed) {
        if (rover.mission.path_clear) {

            if (!rover.mission.pause_mission) {
                //run_mission command.....................
                let rover_heading = rover.robot_data.VFR_HUD.heading || 0;
                let motor_speed_cmd = 0;
                let nav_tuning = rover.nav_tuning || {};

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
                        filtered_yaw_to_waypoint: 0,
                        last_two_wheel_steering_deg: 0
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
                    adaptive_arrival_radius_m = Math.max(0.5, Math.min(2.5, adaptive_arrival_radius_m));

                    //Require being inside arrival radius for multiple cycles to reduce GPS jitter false positives
                    if (rover.mission.nav_accuracy.waypoint_seq !== waypoint.seq) {
                        rover.mission.nav_accuracy.waypoint_seq = waypoint.seq;
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    if (rover.mission.nav_control.waypoint_seq !== waypoint.seq) {
                        rover.mission.nav_control.waypoint_seq = waypoint.seq;
                        rover.mission.nav_control.filtered_yaw_to_waypoint = 0;
                        rover.mission.nav_control.last_two_wheel_steering_deg = 0;
                    }

                    if (distance_to_waypoint_meters <= adaptive_arrival_radius_m) {
                        rover.mission.nav_accuracy.inside_radius_count += 1;
                    } else {
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    //At waypoint: advance sequence immediately to avoid GPS jitter causing yaw direction flips
                    if (rover.mission.nav_accuracy.inside_radius_count >= rover.mission.nav_accuracy.required_inside_radius_count) {
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                         rover.logs.run_mission.log(rover, "waypoint reached: "+rover.mission.current_mission_seq);
                        if (rover.mission.package_delivered) {
                            //reverse through waypoints to return to dock after delivery
                            
                            rover.mission.current_mission_seq -= 1;
                        }
                        else {
                            rover.mission.current_mission_seq += 1;
                        }

                        //stop the rover while target waypoint changes
                        rover.move_rover(rover, 1, 0, "run_mission waypoint_reached");
                        rover.move_rover(rover, 2, 0, "run_mission waypoint_reached");
                        rover.move_rover(rover, 3, 0, "run_mission waypoint_reached");
                        rover.move_rover(rover, 4, 0, "run_mission waypoint_reached");
                        return;
                    }

                    //What is heading of the next waypoint?
                    let waypoint_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
                    //console.log("Next waypoint bearing: " + waypoint_bearing + " Rover heading: " + rover_heading);

                    //yaw rover towards waypoint
                    let yaw_to_waypoint = (waypoint_bearing - rover_heading + 360) % 360;
                    if (yaw_to_waypoint > 180) yaw_to_waypoint -= 360;
                    rover.robot_data.yaw_to_waypoint = yaw_to_waypoint;

                    let filtered_yaw_to_waypoint = rover.mission.nav_control.filtered_yaw_to_waypoint;
                    let yaw_delta = yaw_to_waypoint - filtered_yaw_to_waypoint;
                    if (yaw_delta > 180) yaw_delta -= 360;
                    if (yaw_delta < -180) yaw_delta += 360;
                    filtered_yaw_to_waypoint += yaw_delta * nav_tuning.two_wheel_yaw_filter_alpha;
                    if (filtered_yaw_to_waypoint > 180) filtered_yaw_to_waypoint -= 360;
                    if (filtered_yaw_to_waypoint < -180) filtered_yaw_to_waypoint += 360;
                    rover.mission.nav_control.filtered_yaw_to_waypoint = filtered_yaw_to_waypoint;
                    rover.robot_data.filtered_yaw_to_waypoint = filtered_yaw_to_waypoint;

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

                    if (Math.abs(rover.robot_data.yaw_to_waypoint) > 20) {

                        if (rover.motor.current_steering_type != "four_wheels") {
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


                            //determine motor speed command based on yaw angle
                            motor_speed_cmd = Math.abs(rover.robot_data.yaw_to_waypoint);


                            rover.yaw_rover(rover, rover.robot_data.yaw_to_waypoint, motor_speed_cmd);
                        }
                    }
                    else {


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
                                rover.mission.nav_control.filtered_yaw_to_waypoint = rover.robot_data.yaw_to_waypoint || 0;
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

                            let two_wheel_yaw_abs = Math.abs(filtered_yaw_to_waypoint);
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
                                let steering_target_deg = filtered_yaw_to_waypoint * nav_tuning.two_wheel_steering_gain;
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
        console.log("Rover is disarmed.");
        rover.logs.run_mission.log(rover, "Rover is disarmed");
    };

}


module.exports = run_mission;