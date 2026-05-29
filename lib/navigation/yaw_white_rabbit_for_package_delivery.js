var yaw_white_rabbit_for_package_delivery = function (white_rabbit) {
    if (!white_rabbit.mission.finished_package_yaw) {

        if (!white_rabbit.arduino.connected) {
            console.log("Arduino not connected, skipping delivery yaw and returning to dock");
            white_rabbit.mission.finished_package_yaw = true;
            white_rabbit.mission.package_delivered = true;
            white_rabbit.mission.current_mission_seq -= 2;
            if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
                white_rabbit.learning.add('successful_delivery', {
                    method: 'no_arduino',
                    lat:    white_rabbit.robot_data.robot_latitude,
                    lng:    white_rabbit.robot_data.robot_longitude
                });
            }
            return;
        }

        let white_rabbit_heading = white_rabbit.get_heading(white_rabbit);

        if (!white_rabbit.mission.package_delivery_yaw) {
            // Find the waypoint before the delivery waypoint to aim back toward it for the return trip.
            // current_mission_seq is one past the last waypoint at this point, so seq-2 is the prior waypoint.
            let prior_seq = white_rabbit.mission.current_mission_seq - 2;
            let prior_waypoint = null;
            for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
                if (white_rabbit.mission.waypoints[i].seq === prior_seq &&
                    white_rabbit.mission.waypoints[i].lat && white_rabbit.mission.waypoints[i].lng) {
                    prior_waypoint = white_rabbit.mission.waypoints[i];
                    break;
                }
            }

            if (prior_waypoint) {
                white_rabbit.mission.package_delivery_yaw = white_rabbit.get_bearing(
                    white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude,
                    prior_waypoint.lat, prior_waypoint.lng
                );
                console.log("Delivery yaw: bearing to prior waypoint " + prior_seq + " = " + white_rabbit.mission.package_delivery_yaw);
            } else {
                white_rabbit.mission.package_delivery_yaw = (white_rabbit_heading + 180) % 360;
                console.log("Prior waypoint not found, falling back to 180 turn: " + white_rabbit.mission.package_delivery_yaw);
            }
        }

        const diff = Math.abs(white_rabbit_heading - white_rabbit.mission.package_delivery_yaw);
        const angleDifference = Math.min(diff, 360 - diff);

        if (angleDifference <= 10) {
            console.log("Heading aligned within 10 degrees");

            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "deliver package");
            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "deliver package");
            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "deliver package");
            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "deliver package");

            white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
            white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);

            white_rabbit.mission.finished_package_yaw = true;
            white_rabbit.mission.package_delivery_yaw = false;
            console.log("Send arduino command to auto delivery");

            white_rabbit.create_arduino_message(white_rabbit, 'deliver_package', 0);
            setTimeout(() => {
                white_rabbit.mission.auto_delivery = true;
            }, 2000);

        } else {
            // Compute signed yaw error so yaw_white_rabbit turns the shortest direction
            let yaw_error = (white_rabbit.mission.package_delivery_yaw - white_rabbit_heading + 360) % 360;
            if (yaw_error > 180) yaw_error -= 360;
            let turn_speed = Math.min(50, Math.max(20, Math.round(Math.abs(yaw_error) * 0.4)));
            white_rabbit.yaw_white_rabbit(white_rabbit, yaw_error, turn_speed);
        }
    }
}

module.exports = yaw_white_rabbit_for_package_delivery;