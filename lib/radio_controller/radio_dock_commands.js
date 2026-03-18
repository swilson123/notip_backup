
var radio_dock_commands = function (rover, message) {

    //console.log("rc: ", message);


    if (message.chan7_raw > 1900 && rover.dock.rc_dock != message.chan7_raw) {
        //Undock rover
        console.log("Undock Rover Activated");

        rover.dock.rc_dock = message.chan7_raw;
    }
    else if (message.chan7_raw < 1100 && rover.dock.rc_dock != message.chan7_raw) {
        //Dock rover
        rover.dock.rc_dock = message.chan7_raw;
        console.log("Dock Rover Activated");




    }
    else if (rover.dock.rc_dock != message.chan7_raw) {
        rover.dock.rc_dock = message.chan7_raw;
        console.log("Dock/Undock off, RC Control Activated");
    }



};


module.exports = radio_dock_commands;