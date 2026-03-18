
var radio_dock_commands = function (rover, message) {

    //console.log("rc: ", message);
    if (!rover.robot_data.mission_mode) {

        if (message.chan7_raw > 1900 && rover.dock.rc_dock != message.chan7_raw) {
            //Undock rover
            console.log("Undock Rover Activated");

            rover.dock.rc_dock = message.chan7_raw;

            rover.dock.undock_interval = setInterval(() => {
                rover.undock_rover(rover);
            }, 250);
        }
        else if (message.chan7_raw < 1100 && rover.dock.rc_dock != message.chan7_raw) {
            //Dock rover
            rover.dock.rc_dock = message.chan7_raw;
            console.log("Dock Rover Activated");

            rover.dock.dock_interval = setInterval(() => {
                rover.dock_rover(rover);
            }, 250);


        }
        else if (rover.dock.rc_dock != message.chan7_raw) {
            rover.dock.rc_dock = message.chan7_raw;
            console.log("Dock/Undock off, RC Control Activated");

            clearInterval(rover.dock.undock_interval);
            rover.dock.undock_interval = null;
            clearTimeout(rover.dock.undock_complete_timeout);
            rover.dock.undock_complete_timeout = null;
            rover.dock.dock_state = null;
            //Stop the rover
            rover.move_rover(rover, 1, 0, "radio_dock_commands");
            rover.move_rover(rover, 4, 0, "radio_dock_commands");
            rover.move_rover(rover, 3, 0, "radio_dock_commands");
            rover.move_rover(rover, 2, 0, "radio_dock_commands");
        }


    }
    else {
        console.log("Rover is in mission mode, RC Dock/Undock commands are disabled.");
    }

};


module.exports = radio_dock_commands;