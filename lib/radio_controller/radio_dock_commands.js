
var radio_dock_commands = function (white_rabbit, message) {

    if (typeof white_rabbit.dock.switch_armed !== 'boolean') {
        white_rabbit.dock.switch_armed = false;
    }

    // Require the operator to pass through the middle position once after boot
    // before low/high dock actions are allowed.
    if (!white_rabbit.dock.switch_armed) {
        if (message.chan7_raw > 1100 && message.chan7_raw < 1900) {
            white_rabbit.dock.switch_armed = true;
        }
        white_rabbit.dock.rc_dock = message.chan7_raw;
        return;
    }

    if (message.chan7_raw > 1900 && white_rabbit.dock.rc_dock != message.chan7_raw) {
        // Undock → run full mission: undock, navigate waypoints, deliver, return, dock
        console.log("Full mission sequence activated");
        white_rabbit.dock.rc_dock = message.chan7_raw;

        // Reset mission and dock state for a clean run
        white_rabbit.dock.dock_state = null;
        white_rabbit.dock.follow_state = {};
        white_rabbit.dock.start_mission_after_undock = true;
        white_rabbit.dock.awaiting_stow_ack = false;
        white_rabbit.dock.stow_confirmed = false;
        white_rabbit.dock.stow_command_sent_at = 0;
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
        white_rabbit.dock.awaiting_stow_ack = true;

     
        // white_rabbit.dock.stow_confirmed = false;
        // white_rabbit.dock.stow_command_sent_at = Date.now();

        // white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);

        clearInterval(white_rabbit.dock.dock_interval);
        white_rabbit.dock.dock_interval = setInterval(() => {
        
                white_rabbit.follow_the_light(white_rabbit);
        

            // // Retry stow command in case one serial packet is dropped.
            // if (!white_rabbit.dock.stow_command_sent_at || (Date.now() - white_rabbit.dock.stow_command_sent_at) > 3000) {
            //     white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);
            //     white_rabbit.dock.stow_command_sent_at = Date.now();
            // }
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

        // Cancel any in-progress follow_the_light complete timer so it can't
        // fire after cancellation and overwrite dock_state.
        if (white_rabbit.dock.follow_state && white_rabbit.dock.follow_state.complete_timer) {
            clearTimeout(white_rabbit.dock.follow_state.complete_timer);
        }

        white_rabbit.dock.undock_interval = null;
        white_rabbit.dock.dock_interval = null;
        white_rabbit.mission.mission_interval = null;
        white_rabbit.dock.undock_complete_timeout = null;
        white_rabbit.dock.dock_state = null;
        white_rabbit.dock.follow_state = {};
        white_rabbit.dock.start_mission_after_undock = false;
        white_rabbit.dock.awaiting_stow_ack = false;
        white_rabbit.dock.stow_confirmed = false;
        white_rabbit.dock.stow_command_sent_at = 0;
        white_rabbit.mission.sidewalk_follow_active = false;
        if (white_rabbit.mission.nav_control) {
            white_rabbit.mission.nav_control.sidewalk_seeking = false;
            white_rabbit.mission.nav_control.sidewalk_seek_enter_ts = null;
            white_rabbit.mission.nav_control.sidewalk_seek_exit_ts = null;
        }
        white_rabbit.robot_data.mission_mode = false;

        if (white_rabbit.voice && white_rabbit.voice.tts) white_rabbit.voice.tts.stop();

        white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "radio_dock_commands");
        white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "radio_dock_commands");
        white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "radio_dock_commands");
        white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "radio_dock_commands");
    }

};


module.exports = radio_dock_commands;
