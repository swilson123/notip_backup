var carrot = function (white_rabbit) {

    //carrot the goal of this function is to use edge left XY and edge right XY to provide Noah a carrot to follow.
    //this carrot is what guides noah down the yellow_brick_road.
    //Keep Noah always facing forward on the sidewalk is key.

    //confidence thresholds for path detection
    //white_rabbit.realsense.path_detection.edge_left_conf
    //white_rabbit.realsense.path_detection.edge_right_conf

    //Edge X and Y coordinates in meters
    //white_rabbit.realsense.path_detection.edge_left_x_m
    //white_rabbit.realsense.path_detection.edge_right_x_m
    //white_rabbit.realsense.path_detection.edge_left_y_m
    //white_rabbit.realsense.path_detection.edge_right_y_m

    //EDGES.........................................................
    //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).
    // Confidence gate: reject raw detections below threshold before they reach the steering
    // formula. Prevents far-away low-confidence corner reads (er_y=3.9m, er_c=0.32) from
    // producing 34° spikes. Gated-out values fall back to last-known, then single-edge, then none.
    var _conf_thresh = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.confidence_threshold) || 0.45;
    var edge_left_x = (white_rabbit.realsense.path_detection.edge_left_conf >= _conf_thresh) ? white_rabbit.realsense.path_detection.edge_left_x_m : null;
    var edge_left_y = (white_rabbit.realsense.path_detection.edge_left_conf >= _conf_thresh) ? white_rabbit.realsense.path_detection.edge_left_y_m : null;
    var edge_right_x = (white_rabbit.realsense.path_detection.edge_right_conf >= _conf_thresh) ? white_rabbit.realsense.path_detection.edge_right_x_m : null;
    var edge_right_y = (white_rabbit.realsense.path_detection.edge_right_conf >= _conf_thresh) ? white_rabbit.realsense.path_detection.edge_right_y_m : null;

    // Reported back so follow_the_yellow_brick_road.js can gate on the CONFIDENCE-CHECKED
    // result instead of re-deriving it (or checking the raw, ungated x_m fields).
    white_rabbit.motor.carrot_has_edge = (edge_left_x !== null || edge_right_x !== null);

    if (!edge_right_x) { edge_right_x = 0.1; }
    if (!edge_left_x) { edge_left_x = -0.1; }



    //carrot STEERING...................................................................
    //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).

    // null coerces to 0 in these sums, so with only one edge visible the ratio (and
    // thus the bearing) still reflects that single edge alone.
    var centerline_x = (edge_left_x + edge_right_x) / 2;
    var centerline_y = (edge_left_y + edge_right_y) / 2;
    var _turn_bias_deg = 0;

    // Turn anticipation: when both edges are seen, the side reported farther out
    // (larger y) is a leading signal of an upcoming turn toward that side -- the
    // near/inside edge of a bend recedes or vanishes first, while the far/outside
    // edge stays visible close in. Bias steering toward the receding side now,
    // rather than waiting for the lateral offset to catch up. Positive (right edge
    // farther) -> steer right, matching the +right/+clockwise convention.
    //
    // An earlier version of this also normalized both edges to a common forward
    // distance before averaging x (to avoid mixing one side's x with the other's y
    // at very different depths). That normalization always shrinks whichever edge
    // is farther away, which pulls the centerline toward the NEARER edge -- and the
    // nearer edge is consistently the OUTSIDE of the turn, so it leaned the wrong
    // way on every bend (confirmed on Noah, overpowering K=5). Removed: plain
    // averaging is neutral (not wrong-signed) when the two edges differ mainly in
    // y, leaving this bias term as the sole, unopposed turn-anticipation signal.
    //
    // A lost edge (one side null) reuses this exact same math: treat the missing
    // side as if it receded to edge_lost_recede_m beyond the visible side's y. That
    // makes the (visible_y - lost_y) gap positive on the visible side's own edge and
    // negative on the missing side, so the bias steers back TOWARD the side that
    // disappeared -- the same "go find it again" behavior the old single-edge offset
    // formula gave, but produced by the turn-anticipation term instead of separate code.
    var _turn_gain = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_turn_anticipation_gain_deg_per_m) || 0;
    if (_turn_gain) {
        var _turn_max = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_turn_anticipation_max_deg) || 10;
        var _bias_left_y, _bias_right_y;
        if (edge_left_x !== null && edge_right_x !== null) {
            _bias_left_y = edge_left_y;
            _bias_right_y = edge_right_y;
        } else {
            var _lost_recede_m = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_lost_recede_m) || 0.5;
            if (edge_left_x !== null) {
                // right edge lost -- push it out beyond the left edge's y
                _bias_left_y = edge_left_y;
                _bias_right_y = edge_left_y + _lost_recede_m;
            } else {
                // left edge lost -- push it out beyond the right edge's y
                _bias_left_y = edge_right_y + _lost_recede_m;
                _bias_right_y = edge_right_y;
            }
        }
        _turn_bias_deg = _turn_gain * (_bias_right_y - _bias_left_y);
        if (_turn_bias_deg > _turn_max) _turn_bias_deg = _turn_max;
        if (_turn_bias_deg < -_turn_max) _turn_bias_deg = -_turn_max;
    }

    white_rabbit.motor.steering_turn_bias = _turn_bias_deg;

    white_rabbit.motor.steering_angle_raw = Math.atan2(centerline_x, centerline_y) * (180 / Math.PI) + _turn_bias_deg;


    //adjust steering tune based on angle.......
    var abs_angle = Math.abs(white_rabbit.motor.steering_angle_raw);

    if (abs_angle < 9) white_rabbit.motor.steering_tune = 0.50;
    else if (abs_angle < 9.5) white_rabbit.motor.steering_tune = 0.55;
    else if (abs_angle < 10) white_rabbit.motor.steering_tune = 0.60;
    else if (abs_angle < 11) white_rabbit.motor.steering_tune = 0.65;
    else if (abs_angle < 13) white_rabbit.motor.steering_tune = 0.70;
    else if (abs_angle < 14) white_rabbit.motor.steering_tune = 0.75;
    else if (abs_angle < 15) white_rabbit.motor.steering_tune = 0.80;
    else if (abs_angle < 16) white_rabbit.motor.steering_tune = 0.85;
    else if (abs_angle < 17) white_rabbit.motor.steering_tune = 0.90;
    else if (abs_angle < 18) white_rabbit.motor.steering_tune = 0.95;
    else white_rabbit.motor.steering_tune = 1.00;

    white_rabbit.motor.steering_angle_deg = white_rabbit.motor.steering_angle_raw * white_rabbit.motor.steering_tune;

    //the angle becomes to large for noah to steer past 14 degrees, so we limit the angle to 14 degrees.  This is a safety feature to prevent noah from over steering and tipping over.
    if (white_rabbit.motor.steering_angle_deg > 14) white_rabbit.motor.steering_angle_deg = 14;
    if (white_rabbit.motor.steering_angle_deg < -14) white_rabbit.motor.steering_angle_deg = -14;

    //return carrot steering angle to follow the carrot........
    return white_rabbit.motor.steering_angle_deg;




};
module.exports = carrot;