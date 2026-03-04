var yaw_rover_for_package_delivery = function (rover) {
    if (!rover.mission.finished_package_yaw) {

        //yaw rover 180 degrees to face back towards dock for return trip after delivery
        let rover_heading = rover.robot_data.VFR_HUD.heading || 0;

        if (!rover.mission.package_delivery_yaw) {
            console.log("Setting package delivery yaw");
            rover.mission.package_delivery_yaw = (rover_heading + 180) % 360;
        }



        const diff = Math.abs(rover_heading - rover.mission.package_delivery_yaw);

        // Shortest circular difference
        const angleDifference = Math.min(diff, 360 - diff);

        if (angleDifference <= 10) {
            //Heading aligned within 10 degrees, send command to arduino to deliver package
            console.log("Heading aligned within 10 degrees");

            //stop the rover	


            setTimeout(() => {
                rover.move_rover(rover, 1, 0, "deliver package");
            }, 10);
            setTimeout(() => {
                rover.move_rover(rover, 4, 0, "deliver package");
            }, 20);
            setTimeout(() => {
                rover.move_rover(rover, 3, 0, "deliver package");
            }, 30);
            setTimeout(() => {
                rover.move_rover(rover, 2, 0, "deliver package");
            }, 40);

            //set servos to initial positions
            rover.servo_send_command(rover, 11, 1500, false);
            rover.servo_send_command(rover, 12, 1500, false);
            rover.servo_send_command(rover, 13, 1500, false);
            rover.servo_send_command(rover, 14, 1500, false);

            rover.mission.finished_package_yaw = true;
            rover.mission.package_delivery_yaw = false;
            console.log("Send arduino command to auto delivery");
            rover.create_arduino_message(rover, 'deliver_package', 0);

            setTimeout(() => {
                //Wait 2 seconds to allow arduino to process command 
                rover.mission.auto_delivery = true;
            }, 2000);
        }
        else {
            motor_speed_cmd = Math.abs(rover.mission.package_delivery_yaw);
            //Yaw rover prior to deliver package. This will help ensure rover is facing the correct direction for return trip to dock after delivery
            rover.yaw_rover(rover, rover.mission.package_delivery_yaw, motor_speed_cmd);
        }


    }




}

module.exports = yaw_rover_for_package_delivery;