var throttle_up = function (rover, speed) {
   
    //thottle up to speed command, but only increase by 25 at a time to prevent sudden jumps in speed
    rover.motor.motor_speed_cmd = speed;

    if(rover.motor.last_motor_speed_cmd < rover.motor.motor_speed_cmd - 25){
        rover.motor.last_motor_speed_cmd += 25;

    }
    else{
        rover.motor.last_motor_speed_cmd = rover.motor.motor_speed_cmd;
    }

    return rover.motor.last_motor_speed_cmd;



}

module.exports = throttle_up;