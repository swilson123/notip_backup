var yaw_rover_for_package_delivery = function (rover) {
    if (!rover.mission.finished_package_yaw) {

        if (!rover.arduino.connected) {
            console.log("Arduino not connected, skipping delivery yaw and returning to dock");
            rover.mission.finished_package_yaw = true;
            rover.mission.package_delivered = true;
            rover.mission.current_mission_seq -= 2;
            return;
        }

        let rover_heading = rover.robot_data.VFR_HUD.heading || 0;

        if (!rover.mission.package_delivery_yaw) {
            // Find the waypoint before the delivery waypoint to aim back toward it for the return trip.
            // current_mission_seq is one past the last waypoint at this point, so seq-2 is the prior waypoint.
            let prior_seq = rover.mission.current_mission_seq - 2;
            let prior_waypoint = null;
            for (let i = 0; i < rover.mission.waypoints.length; i++) {
                if (rover.mission.waypoints[i].seq === prior_seq &&
                    rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
                    prior_waypoint = rover.mission.waypoints[i];
                    break;
                }
            }

            if (prior_waypoint) {
                rover.mission.package_delivery_yaw = rover.get_bearing(
                    rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                    prior_waypoint.lat, prior_waypoint.lng
                );
                console.log("Delivery yaw: bearing to prior waypoint " + prior_seq + " = " + rover.mission.package_delivery_yaw);
            } else {
                rover.mission.package_delivery_yaw = (rover_heading + 180) % 360;
                console.log("Prior waypoint not found, falling back to 180 turn: " + rover.mission.package_delivery_yaw);
            }
        }

        const diff = Math.abs(rover_heading - rover.mission.package_delivery_yaw);
        const angleDifference = Math.min(diff, 360 - diff);

        if (angleDifference <= 10) {
            console.log("Heading aligned within 10 degrees");

            rover.move_rover(rover, 1, 0, "deliver package");
            rover.move_rover(rover, 4, 0, "deliver package");
            rover.move_rover(rover, 3, 0, "deliver package");
            rover.move_rover(rover, 2, 0, "deliver package");

            rover.servo_send_command(rover, 11, 1500, false);
            rover.servo_send_command(rover, 12, 1500, false);
            rover.servo_send_command(rover, 13, 1500, false);
            rover.servo_send_command(rover, 14, 1500, false);

            rover.mission.finished_package_yaw = true;
            rover.mission.package_delivery_yaw = false;
            console.log("Send arduino command to auto delivery");

            rover.create_arduino_message(rover, 'deliver_package', 0);
            setTimeout(() => {
                rover.mission.auto_delivery = true;
            }, 2000);

        } else {
            // Compute signed yaw error so yaw_rover turns the shortest direction
            let yaw_error = (rover.mission.package_delivery_yaw - rover_heading + 360) % 360;
            if (yaw_error > 180) yaw_error -= 360;
            let turn_speed = Math.min(50, Math.max(20, Math.round(Math.abs(yaw_error) * 0.4)));
            rover.yaw_rover(rover, yaw_error, turn_speed);
        }
    }
}

module.exports = yaw_rover_for_package_delivery;