
var radio_dock_commands = function (rover, message) {

    if (message.chan7_raw > 1900 && rover.dock.rc_dock != message.chan7_raw) {
        // Undock → run full mission: undock, navigate waypoints, deliver, return, dock
        console.log("Full mission sequence activated");
        rover.dock.rc_dock = message.chan7_raw;

        // Reset mission and dock state for a clean run
        rover.dock.dock_state = null;
        rover.dock.follow_state = {};
        rover.dock.start_mission_after_undock = true;
        rover.mission.current_mission_seq = 0;
        rover.mission.package_delivered = false;
        rover.mission.dock_return_phase = null;

        rover.dock.undock_interval = setInterval(() => {
            rover.undock_rover(rover);
        }, 250);
    }
    else if (message.chan7_raw < 1100 && rover.dock.rc_dock != message.chan7_raw) {
        // Dock → test dock sequence with IRLock
        console.log("Test dock sequence activated");
        rover.dock.rc_dock = message.chan7_raw;

        rover.dock.dock_state = null;
        rover.dock.follow_state = {};

        rover.dock.dock_interval = setInterval(() => {
            rover.dock_rover(rover);
        }, 250);
    }
    else if (rover.dock.rc_dock != message.chan7_raw) {
        // Off → no dock required; stop all sequences and return to RC control
        console.log("Dock switch off — stopping all sequences");
        rover.dock.rc_dock = message.chan7_raw;

        clearInterval(rover.dock.undock_interval);
        clearInterval(rover.dock.dock_interval);
        clearInterval(rover.mission.mission_interval);
        clearTimeout(rover.dock.undock_complete_timeout);

        rover.dock.undock_interval = null;
        rover.dock.dock_interval = null;
        rover.mission.mission_interval = null;
        rover.dock.undock_complete_timeout = null;
        rover.dock.dock_state = null;
        rover.dock.start_mission_after_undock = false;
        rover.robot_data.mission_mode = false;

        rover.move_rover(rover, 1, 0, "radio_dock_commands");
        rover.move_rover(rover, 2, 0, "radio_dock_commands");
        rover.move_rover(rover, 3, 0, "radio_dock_commands");
        rover.move_rover(rover, 4, 0, "radio_dock_commands");
    }

};


module.exports = radio_dock_commands;
