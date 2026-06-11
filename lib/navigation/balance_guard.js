var ROLL_DANGER_DEG = 20;   // tip risk — halt immediately
var ROLL_WARN_DEG   = 10;   // off-camber — log only
var PITCH_DANGER_DEG = 25;  // extreme forward/back pitch outside ramp — halt

var balance_guard = function (white_rabbit) {
    // Run on whatever attitude source is live — the external IMU (if enabled) or
    // the Pixhawk ATTITUDE. get_roll/get_pitch handle the fallback; only bail when
    // there is no attitude data at all (otherwise the tip-over guard would be
    // disabled whenever the IMU is turned off).
    var imu_live = white_rabbit.imu_data && white_rabbit.imu_data.connected;
    var att_live = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE;
    if (!imu_live && !att_live) return;

    var roll_rad  = white_rabbit.get_roll(white_rabbit);
    var pitch_rad = white_rabbit.get_pitch(white_rabbit);
    var roll_deg  = Math.abs(roll_rad  * 180 / Math.PI);
    var pitch_deg = Math.abs(pitch_rad * 180 / Math.PI);

    // High pitch is normal on the ramp — skip pitch check during dock operations.
    var on_ramp = white_rabbit.dock && white_rabbit.dock.dock_state !== null;

    var tip_risk = roll_deg > ROLL_DANGER_DEG || (!on_ramp && pitch_deg > PITCH_DANGER_DEG);

    if (tip_risk) {
        white_rabbit.mission.balance_halt = true;

        // Stop all motors
        white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'balance_guard');
        white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'balance_guard');
        white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'balance_guard');
        white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'balance_guard');

        // Announce once — don't repeat every 250ms tick
        if (!white_rabbit.mission._balance_halt_announced) {
            white_rabbit.mission._balance_halt_announced = true;
            console.log('balance_guard: HALT — roll=' + roll_deg.toFixed(1) + '° pitch=' + pitch_deg.toFixed(1) + '°');
            if (white_rabbit.voice) white_rabbit.voice.say('Noah is off balance. Holding position.');
        }
        return;
    }

    // Recovery: clear halt when safely back within bounds
    var recovered = roll_deg < (ROLL_WARN_DEG / 2) && (on_ramp || pitch_deg < (PITCH_DANGER_DEG / 2));
    if (recovered && white_rabbit.mission.balance_halt) {
        white_rabbit.mission.balance_halt = false;
        white_rabbit.mission._balance_halt_announced = false;
        console.log('balance_guard: balance restored — roll=' + roll_deg.toFixed(1) + '°');
        if (white_rabbit.voice) white_rabbit.voice.say('Balance restored. Continuing mission.');
    }

    // Warning zone: log the lean without stopping
    if (roll_deg > ROLL_WARN_DEG) {
        console.log('balance_guard: warning — roll=' + roll_deg.toFixed(1) + '° (>' + ROLL_WARN_DEG + '°)');
    }
};

module.exports = balance_guard;
