var throttle_up = function (white_rabbit, speed) {
   
    //ramp toward the speed command by 25 at a time to prevent sudden jumps in speed.
    //Ramps both up and down; emergency/obstacle stops bypass this (they zero the
    //motor command directly via stop_white_rabbit), so a safety stop is never delayed.
    white_rabbit.motor.motor_speed_cmd = speed;

    if(white_rabbit.motor.last_motor_speed_cmd < white_rabbit.motor.motor_speed_cmd - 25){
        white_rabbit.motor.last_motor_speed_cmd += 25;

    }
    else if(white_rabbit.motor.last_motor_speed_cmd > white_rabbit.motor.motor_speed_cmd + 25){
        white_rabbit.motor.last_motor_speed_cmd -= 25;
    }
    else{
        white_rabbit.motor.last_motor_speed_cmd = white_rabbit.motor.motor_speed_cmd;
    }

    return white_rabbit.motor.last_motor_speed_cmd;



}

module.exports = throttle_up;