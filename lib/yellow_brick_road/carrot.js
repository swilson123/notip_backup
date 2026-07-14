var carrot = function (white_rabbit) {
    //if noah is huging the left add degrees
    //if noah is huging the right subtract degreees
    // Value lives in setup.json (nav_tuning.steering_trim_deg) so it's shared with the
    // same correction applied to the IRLock dock/undock steering in follow_the_light.js
    // and down_the_rabbit_hole.js -- Noah hugs the left side of the ramps too.
    return white_rabbit.realsense.path_detection.x_angle_deg + white_rabbit.nav_tuning.steering_trim_deg;
};
module.exports = carrot;
