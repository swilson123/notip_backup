
var radio_dock_commands = function (white_rabbit, message) {

    if (message.chan7_raw > 1900 && white_rabbit.dock.rc_dock != message.chan7_raw) {
        // Undock → run full mission: undock, navigate waypoints, deliver, return, dock
        console.log("Full mission sequence activated");
        white_rabbit.dock.rc_dock = message.chan7_raw;

        // Reset mission and dock state for a clean run
        white_rabbit.dock.dock_state = null;
        white_rabbit.dock.follow_state = {};
        white_rabbit.dock.start_mission_after_undock = true;
        white_rabbit.mission.current_mission_seq = 0;
        white_rabbit.mission.package_delivered = false;
        white_rabbit.mission.dock_return_phase = null;

        white_rabbit.dock.undock_interval = setInterval(() => {
            white_rabbit.undock_white_rabbit(white_rabbit);
        }, 250);
    }
    else if (message.chan7_raw < 1100 && white_rabbit.dock.rc_dock != message.chan7_raw) {
        // Dock → test dock sequence with IRLock
        console.log("Test dock sequence activated");
        white_rabbit.dock.rc_dock = message.chan7_raw;

        white_rabbit.dock.dock_state = null;
        white_rabbit.dock.follow_state = {};

        white_rabbit.dock.dock_interval = setInterval(() => {
            white_rabbit.dock_white_rabbit(white_rabbit);
        }, 250);
    }
    else if (white_rabbit.dock.rc_dock != message.chan7_raw) {
        // Off → no dock required; stop all sequences and return to RC control
        console.log("Dock switch off — stopping all sequences");
        white_rabbit.dock.rc_dock = message.chan7_raw;

        clearInterval(white_rabbit.dock.undock_interval);
        clearInterval(white_rabbit.dock.dock_interval);
        clearInterval(white_rabbit.mission.mission_interval);
        clearTimeout(white_rabbit.dock.undock_complete_timeout);

        white_rabbit.dock.undock_interval = null;
        white_rabbit.dock.dock_interval = null;
        white_rabbit.mission.mission_interval = null;
        white_rabbit.dock.undock_complete_timeout = null;
        white_rabbit.dock.dock_state = null;
        white_rabbit.dock.start_mission_after_undock = false;
        white_rabbit.robot_data.mission_mode = false;

        white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "radio_dock_commands");
        white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "radio_dock_commands");
        white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "radio_dock_commands");
        white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "radio_dock_commands");
    }

};


module.exports = radio_dock_commands;
