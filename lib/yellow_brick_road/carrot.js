var carrot = function (white_rabbit) {
    //return carrot steering angle to follow the carrot........

    var max_x_angle_deg = 10;
    var steer_input_max_deg = 20; // raw camera angle treated as full-deflection input
    var steering_gain = 0.15; //raction of the remaining error closed per tick -- moves toward the target angle instead of snapping to it

    // Scale (not clamp) into the output range: clamp the raw input to its own physical
    // range first, then linearly rescale that onto +/- max_x_angle_deg. A flat clamp
    // makes a 20deg raw angle command the same as a 10deg one; a 20deg raw angle should
    // still steer harder than a 10deg one.
    var raw_angle_deg = white_rabbit.realsense.path_detection.x_angle_deg;
    var clamped_input_deg = Math.max(-steer_input_max_deg, Math.min(steer_input_max_deg, raw_angle_deg));
    var target_angle_deg = (clamped_input_deg / steer_input_max_deg) * max_x_angle_deg;

    var current_angle_deg = white_rabbit.motor.steering_angle_deg || 0;

    return current_angle_deg + steering_gain * (target_angle_deg - current_angle_deg);
};
module.exports = carrot;
