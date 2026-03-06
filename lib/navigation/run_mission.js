var run_mission = function (rover) {
    if (rover.robot_data.is_armed) {
        if (rover.mission.path_clear) {

            if (!rover.mission.pause_mission) {
                //run_mission command.....................
                let rover_heading = rover.robot_data.VFR_HUD.heading || 0;
                let motor_speed_cmd = 0;




                //What is the next waypoint?
                let waypoint = { latitude: null, longitude: null };

                if (rover.mission.package_delivered) {
                    //reverse through waypoints to return to dock after delivery
                    for (let i = rover.mission.waypoints.length - 1; i >= 0; i--) {

                        if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {

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

                    //What is heading of the next waypoint?
                    let waypoint_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
                    //console.log("Next waypoint bearing: " + waypoint_bearing + " Rover heading: " + rover_heading);

                    //yaw rover towards waypoint
                    let yaw_to_waypoint = (waypoint_bearing - rover_heading + 360) % 360;
                    if (yaw_to_waypoint > 180) yaw_to_waypoint -= 360;
                    rover.robot_data.yaw_to_waypoint = yaw_to_waypoint;
                    if (Math.abs(rover.robot_data.yaw_to_waypoint) > 20 || distance_to_waypoint_meters < 1 && Math.abs(rover.robot_data.yaw_to_waypoint) > 5) {

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
                            }
                        } else if (rover.motor.current_steering_type == "two_wheels") {



                            //move forward towards waypoint
                            if (distance_to_waypoint_meters > 1) {

                                if (rover.rplidar.avoid_object) {
                                    if (rover.zones[10].light == "yellow" && rover.zones[10].distance_mm) {
                                        motor_speed_cmd = rover.calc_speed_based_on_distance(rover.zones[10], rover.zones[10].distance_mm);
                                    }
                                    else if (rover.zones[11].light == "yellow" && rover.zones[11].distance_mm) {
                                        motor_speed_cmd = rover.calc_speed_based_on_distance(rover.zones[11], rover.zones[11].distance_mm);
                                    }
                                    else {
                                        motor_speed_cmd = rover.throttle_up(rover, 200);
                                    }
                                }
                                else {
                                    motor_speed_cmd = rover.throttle_up(rover, 200);
                                }
                            }
                            else if (distance_to_waypoint_meters <= 1) {
                                //waypoint reached
                                if (rover.mission.package_delivered) {
                                    //reverse through waypoints to return to dock after delivery
                                    rover.mission.current_mission_seq -= 1;
                                }
                                else {
                                    rover.mission.current_mission_seq += 1;

                                }
                                motor_speed_cmd = 0;
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

                                setTimeout(() => {
                                    //front passenger
                                    rover.move_rover(rover, 1, steering_and_rpm.motor_rpm.front_passenger, "run_mission all wheel");
                                }, 10);

                                setTimeout(() => {
                                    //rear passenger side
                                    rover.move_rover(rover, 2, steering_and_rpm.motor_rpm.back_passenger, "run_mission all wheel");

                                }, 20);

                                setTimeout(() => {
                                    //front driver side
                                    rover.move_rover(rover, 3, steering_and_rpm.motor_rpm.front_driver, "run_mission all wheel");
                                }, 30);

                                setTimeout(() => {
                                    //rear driver side
                                    rover.move_rover(rover, 4, steering_and_rpm.motor_rpm.back_driver, "run_mission all wheel");
                                }, 40);

                            } else {

                                //steer towards waypoint complete, move forward
                                var steer_pwm = rover.angle_to_pwm(rover.robot_data.yaw_to_waypoint);
                                rover.servo_send_command(rover, 12, 1500, false);
                                rover.servo_send_command(rover, 14, 1500, false);
                                rover.servo_send_command(rover, 11, steer_pwm.servo1, true);
                                rover.servo_send_command(rover, 13, steer_pwm.servo2, true);

                                setTimeout(() => {
                                    rover.move_rover(rover, 1, motor_speed_cmd * -1, "run_mission 2 wheel");
                                }, 10);
                                setTimeout(() => {
                                    rover.move_rover(rover, 4, motor_speed_cmd, "run_mission 2 wheel");
                                }, 20);
                                setTimeout(() => {
                                    rover.move_rover(rover, 3, motor_speed_cmd, "run_mission 2 wheel");
                                }, 30);
                                setTimeout(() => {
                                    rover.move_rover(rover, 2, motor_speed_cmd * -1, "run_mission 2 wheel");
                                }, 40);
                            }

                        }
                    }

                }
                else {
                    if (!rover.mission.package_delivered) {
                        rover.yaw_rover_for_package_delivery(rover);
                    }
                    else {
                        console.log("Mission Finished. No waypoint data available.");
                        clearInterval(rover.mission.mission_interval);
                    }
                }
            }
            else {
                console.log("Mission paused.");
            }

        }
    } else {
        console.log("Rover is disarmed.");
    };

}


module.exports = run_mission;