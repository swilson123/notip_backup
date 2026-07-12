var carrot = function (white_rabbit) {
    //return carrot steering angle to follow the carrot........

    var max_x_angle_deg = 12;
    var steering_gain = 0.3; // fraction of the remaining error closed per tick -- moves toward the target angle instead of snapping to it

    var target_angle_deg = Math.max(-max_x_angle_deg, Math.min(max_x_angle_deg,
        white_rabbit.realsense.path_detection.x_angle_deg));

    var current_angle_deg = white_rabbit.motor.steering_angle_deg || 0;

    return current_angle_deg + steering_gain * (target_angle_deg - current_angle_deg);
};
module.exports = carrot;
