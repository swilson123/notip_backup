var undock_rover = function (rover) {
    if (rover.robot_data.is_armed) {
        console.log("Undocking Rover....." + rover.robot_data.ATTITUDE.pitch);
        var motor_speed_cmd = 25;

        if (!rover.dock.dock_state) {
            console.log("Undocking Rover");
            rover.dock.dock_state = "docked";
        }
        else if (rover.dock.dock_state === "docked") {
            //record the location of the dock for later use
            rover.dock.dock_latitude = rover.robot_data.robot_latitude;
            rover.dock.dock_longitude = rover.robot_data.robot_longitude;
            rover.dock.dock_pitch = rover.robot_data.ATTITUDE.pitch;
            rover.dock.dock_heading = rover.robot_data.VFR_HUD.heading;


            // start the undocking process by moving the rover forward off the dock
            rover.move_rover(rover, 1, motor_speed_cmd * -1, "undock_rover");
            rover.move_rover(rover, 4, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 3, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 2, motor_speed_cmd * -1, "undock_rover");



            if (rover.robot_data.ATTITUDE.pitch < rover.dock.dock_pitch - 10) {
                rover.dock.dock_state = "undocking_ramp";
                console.log("Rover going down the ramp");
            }
        }
        else if (rover.dock.dock_state === "undocking_ramp") {
            // rover is going down the ramp

            //continue moving the rover down the ramp
            rover.move_rover(rover, 1, motor_speed_cmd * -1, "undock_rover");
            rover.move_rover(rover, 4, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 3, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 2, motor_speed_cmd * -1, "undock_rover");

            if (rover.robot_data.ATTITUDE.pitch > rover.dock.dock_pitch - 10) {
                rover.dock.dock_state = "undocked";
                console.log("Rover going down the ramp");
            }


        }
        else if (rover.dock.dock_state === "undocked") {
            // rover has finished going down the ramp
            rover.dock.dock_state = "undocked_complete";

            //record the location of the undock for later use
            rover.dock.undock_latitude = rover.robot_data.robot_latitude;
            rover.dock.undock_longitude = rover.robot_data.robot_longitude;
            rover.dock.undock_pitch = rover.robot_data.ATTITUDE.pitch;
            rover.dock.undock_heading = rover.robot_data.VFR_HUD.heading;

            //Stop the rover after undocking
            rover.move_rover(rover, 1, 0, "undock_rover");
            rover.move_rover(rover, 4, 0, "undock_rover");
            rover.move_rover(rover, 3, 0, "undock_rover");
            rover.move_rover(rover, 2, 0, "undock_rover");

            console.log("Rover has finished going down the ramp");
        }


    } else {
        console.log("Rover is disarmed.");
    };

};

module.exports = undock_rover;
