var undock_rover = function (rover) {
    if (rover.robot_data.is_armed) {
        if (!rover.imu_data.connected && !rover.robot_data.ATTITUDE) {
            console.log("Undock waiting for ATTITUDE message");
            return;
        }

      
        var motor_speed_cmd = 25;
        var ramp_detect_pitch_delta = 0.12; // ~6.9 deg
        var level_pitch_tolerance = 0.07;   // ~4.0 deg
        var post_ramp_drive_ms = 3000;

        if (!rover.dock.dock_state) {
            console.log("Undocking Rover");
            rover.dock.dock_state = "docked";

            // Record initial dock pose once at undock start.
            rover.dock.dock_latitude = rover.robot_data.robot_latitude;
            rover.dock.dock_longitude = rover.robot_data.robot_longitude;
            rover.dock.dock_pitch = rover.get_pitch(rover);
            rover.dock.dock_heading = rover.get_heading(rover);

            rover.dock.ramp_started_at = null;
        }
        else if (rover.dock.dock_state === "docked") {
            // start the undocking process by moving the rover forward off the dock
            rover.move_rover(rover, 1, motor_speed_cmd * -1, "undock_rover");
            rover.move_rover(rover, 4, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 3, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 2, motor_speed_cmd * -1, "undock_rover");

            var pitch_delta = rover.get_pitch(rover) - rover.dock.dock_pitch;

            // Enter ramp state once pitch departs enough from the original dock pitch.
            if (Math.abs(pitch_delta) >= ramp_detect_pitch_delta) {
                rover.dock.dock_state = "undocking_ramp";
                rover.dock.ramp_started_at = Date.now();
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

            var ramp_pitch_delta = rover.get_pitch(rover) - rover.dock.dock_pitch;
            var on_ramp_long_enough = rover.dock.ramp_started_at && (Date.now() - rover.dock.ramp_started_at > 1000);

            // Consider ramp complete when pitch settles near initial level after at least 1s on ramp.
            if (on_ramp_long_enough && Math.abs(ramp_pitch_delta) <= level_pitch_tolerance) {
                rover.dock.dock_state = "undocked";
                console.log("Rover finished going down the ramp");
            }


        }
        else if(rover.dock.dock_state === "undocked"){

            //Continue moving the rover forward for a short time to ensure it is clear of the dock
            rover.move_rover(rover, 1, motor_speed_cmd * -1, "undock_rover");
            rover.move_rover(rover, 4, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 3, motor_speed_cmd, "undock_rover");
            rover.move_rover(rover, 2, motor_speed_cmd * -1, "undock_rover");

            if(!rover.dock.undock_complete_timeout){
                rover.dock.undock_complete_timeout = setTimeout(() => {
                  
                    rover.dock.dock_state = "undocked_completed";
                    rover.dock.undock_complete_timeout = null;
                    console.log("Rover should now be clear of the dock");
                }, post_ramp_drive_ms);
            }
        }
        else if (rover.dock.dock_state === "undocked_completed") {
            
            //record the location of the undock for later use
            rover.dock.undock_latitude = rover.robot_data.robot_latitude;
            rover.dock.undock_longitude = rover.robot_data.robot_longitude;
            rover.dock.undock_pitch = rover.get_pitch(rover);
            rover.dock.undock_heading = rover.get_heading(rover);

            //Stop the rover after undocking
            rover.move_rover(rover, 1, 0, "undock_rover");
            rover.move_rover(rover, 4, 0, "undock_rover");
            rover.move_rover(rover, 3, 0, "undock_rover");
            rover.move_rover(rover, 2, 0, "undock_rover");

            // Stop undock loop once completed.
            if (rover.dock.undock_interval) {
                clearInterval(rover.dock.undock_interval);
                rover.dock.undock_interval = null;
            }

            console.log("Undock complete, rover is now free from the dock");
        }


    } else {
        console.log("Rover is disarmed.");
    };

};

module.exports = undock_rover;
