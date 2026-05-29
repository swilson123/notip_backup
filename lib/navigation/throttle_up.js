var throttle_up = function (white_rabbit, speed) {
   
    //thottle up to speed command, but only increase by 25 at a time to prevent sudden jumps in speed
    white_rabbit.motor.motor_speed_cmd = speed;

    if(white_rabbit.motor.last_motor_speed_cmd < white_rabbit.motor.motor_speed_cmd - 25){
        white_rabbit.motor.last_motor_speed_cmd += 25;

    }
    else{
        white_rabbit.motor.last_motor_speed_cmd = white_rabbit.motor.motor_speed_cmd;
    }

    return white_rabbit.motor.last_motor_speed_cmd;



}

module.exports = throttle_up;