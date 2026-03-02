var ddsm_motor_test = function (rover) {

    

    // command constants from Waveshare example (ddsm_example/json_cmd.h)
    const CMD_DDSM_CTRL = 10010;        // speed/current/position control
    const CMD_DDSM_CHANGE_ID = 10011;   // change motor ID
    const CMD_CHANGE_MODE = 10012;      // change mode
    const CMD_DDSM_ID_CHECK = 10031;    // query motor ID (only one motor connected)
    const CMD_DDSM_INFO = 10032;        // get info for a motor
    const CMD_HEARTBEAT_TIME = 11001;   // set heartbeat time
    const motor_id = 4
    const motor_speed_cmd = 200;


    // send change ID (example: set motor with physical connection to ID 1 -> change to 2)
    // Only one motor should be connected when sending this command
    setTimeout(() => {
        if (rover.waveshare.connected) {
          var message = { "T": CMD_DDSM_CHANGE_ID, "id": motor_id };
            rover.create_waveshare_message(rover, message);


        } else {
            console.log("Waveshare not connected");
        }
    }, 1000);

    setTimeout(() => {
        if (rover.waveshare.connected) {
            var message = { "T": CMD_CHANGE_MODE, "id": motor_id, "mode": 2 };
            rover.create_waveshare_message(rover, message);
        } else {
            console.log("Waveshare not connected");
        }
    }, 2000);

    // set heartbeat time (-1 disables automatic stop)
    setTimeout(() => {
        if (rover.waveshare.connected) {
            var message = { "T": CMD_HEARTBEAT_TIME, "time": 2000 };
            rover.create_waveshare_message(rover, message);
        } else {
            console.log("Waveshare not connected");
        }
    }, 3000);

};

module.exports = ddsm_motor_test;