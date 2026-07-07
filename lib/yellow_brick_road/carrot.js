var carrot = function (white_rabbit) {

    //carrot: computes white_rabbit.motor.steering_angle_deg, the one number that tells
    //Noah to steer left or right to stay on the sidewalk. This IS the carrot Noah
    //follows down the yellow_brick_road.

    //Steering comes straight from realsense rather than any local edge-geometry math.
    //Live edge guidance (x_angle_deg) is primary; when Python itself says the live
    //camera frame can't be trusted (edge_guidance_valid false — e.g. camera panned off
    //the sidewalk mid-turn), fall back to map_angle_deg, the persistent heading-anchored
    //path_map's projection of the sidewalk center at the same lookahead distance,
    //re-expressed in Noah's current heading. Both use the same sign convention (>0 =
    //target to the RIGHT), so the same correction_direction flip (calc_steering_and_rpm
    //treats steering_angle_deg > 0 as turn LEFT) applies to whichever source is chosen.
    var _steer_source_angle_deg = white_rabbit.realsense.path_detection.edge_guidance_valid
        ? white_rabbit.realsense.path_detection.x_angle_deg
        : white_rabbit.realsense.path_detection.map_angle_deg;

    var _steer_target_deg =
        (typeof _steer_source_angle_deg === 'number' ? _steer_source_angle_deg : 0)
        * white_rabbit.realsense.vision.correction_direction;

    // Deadband: an angle this small is noise, not a real correction worth chasing.
    if (Math.abs(_steer_target_deg) < white_rabbit.realsense.vision.edge_steer_deadband_deg) {
        _steer_target_deg = 0;
    }

    // Scale (not clamp) into the sidewalk steering range, the same way pwm_to_angle.js
    // turns an RC stick's PWM range into a servo angle: clamp the raw input to its
    // known physical range first, then linearly rescale that clamped range onto the
    // output range. Here the "physical range" is sidewalk_steer_input_max_deg -- the
    // raw camera angle treated as a full-deflection input -- and the output range is
    // +/- sidewalk_steer_max_deg. A 20 deg carrot angle still steers harder than a
    // 15 deg one; a flat clamp would make them command the same angle.
    var _steer_max_deg = white_rabbit.realsense.vision.sidewalk_steer_max_deg;
    var _steer_input_max_deg = white_rabbit.realsense.vision.sidewalk_steer_input_max_deg;
    var _steer_clamped_input_deg = Math.max(-_steer_input_max_deg, Math.min(_steer_input_max_deg, _steer_target_deg));
    _steer_target_deg = (_steer_clamped_input_deg / _steer_input_max_deg) * _steer_max_deg;

    // Pre-smoothing target, for the steer log in follow_the_yellow_brick_road.js
    // (angle_raw vs angle shows the smoothing gap live while tuning steering_time_constant_s).
    white_rabbit.motor.steering_angle_raw = _steer_target_deg;

    // Ease toward the target over steering_time_constant_s seconds instead of
    // snapping to it every tick -- one physical knob (seconds to settle) instead of
    // separate gain + max-degrees-per-tick constants, since "per tick" isn't a fixed
    // unit here: realsense throttles its own fps between 7-15Hz under CPU load, so a
    // fixed degrees-per-tick cap would make Noah turn at a different real-world rate
    // depending on how busy the Pi is. alpha is derived from the ACTUAL elapsed
    // wall-clock time since the last tick, so this stays correct regardless.
    var _steer_now_ts = Date.now();
    var _steer_prev_deg = typeof white_rabbit.motor.steering_angle_deg === 'number' ? white_rabbit.motor.steering_angle_deg : 0;
    var _steer_alpha = 1;
    if (white_rabbit.motor.steering_smooth_ts) {
        var _steer_dt_s = (_steer_now_ts - white_rabbit.motor.steering_smooth_ts) / 1000;
        var _steer_tau_s = white_rabbit.realsense.vision.steering_time_constant_s;
        _steer_alpha = _steer_tau_s > 0 ? Math.min(1, _steer_dt_s / _steer_tau_s) : 1;
    }
    white_rabbit.motor.steering_smooth_ts = _steer_now_ts;

    white_rabbit.motor.steering_angle_deg = _steer_prev_deg + _steer_alpha * (_steer_target_deg - _steer_prev_deg);

    //return carrot steering angle to follow the carrot........
    return white_rabbit.motor.steering_angle_deg;

};
module.exports = carrot;
