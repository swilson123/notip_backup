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

    // Captured BEFORE the default substitution below overwrites the nulls, so the
    // turn-bias block further down can still tell a real edge from a fallback default.
    var _had_left_edge = (edge_left_x !== null);
    var _had_right_edge = (edge_right_x !== null);

    // Reported back so follow_the_yellow_brick_road.js can gate on the CONFIDENCE-CHECKED
    // result instead of re-deriving it (or checking the raw, ungated x_m fields).
    white_rabbit.motor.carrot_has_edge = (_had_left_edge || _had_right_edge);

    if (!edge_right_x) { edge_right_x = 0.1; }
    if (!edge_left_x) { edge_left_x = -0.1; }



    //carrot STEERING...................................................................
    //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).

    // edge_left_x/edge_right_x are never null here (defaulted to +-0.1 above), so this
    // average is always a true 2-term average. edge_left_y/edge_right_y have NO such
    // default -- a missing one is still literally null/undefined at this point.
    var centerline_x = (edge_left_x + edge_right_x) / 2;

    // Bug fixed 2026-07-01, from the first autonomous test after the RC capture: with
    // only one edge visible the old code did (real_y + 0) / 2, i.e. treated the visible
    // edge as HALF as far away as it actually is. Since atan2's angle grows sharply as
    // the y (forward) term shrinks toward the x (lateral) term, this alone roughly
    // doubled the steering angle every time one edge dropped out -- confirmed on Noah's
    // own capture (logger/2026-07-01/13/rc_edge_capture_1): every one of the 16 ticks
    // with exactly one edge lost produced |steer_deg| > 8deg, 9 of them pinned to the
    // +-14deg clamp, including a straight -14 -> +14 flip in back-to-back ticks. Use the
    // visible edge's real y untouched instead of halving it; only average when both
    // are actually present.
    var centerline_y;
    if (_had_left_edge && _had_right_edge) {
        centerline_y = (edge_left_y + edge_right_y) / 2;
    } else if (_had_left_edge) {
        centerline_y = edge_left_y;
    } else if (_had_right_edge) {
        centerline_y = edge_right_y;
    } else {
        centerline_y = 0;
    }
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
    //
    // edge_turn_anticipation_gain_deg_per_m cut from 10 to 3 on 2026-07-01, from the first
    // RC hand-driven capture (logger/2026-07-01/12/rc_edge_capture_1 and _2, 170 ticks):
    // at gain=10 this term alone swung as far as -9deg while Scott held the stick at 0,
    // on a mostly-straight stretch of sidewalk -- ordinary per-side depth-reading noise
    // (el_y/er_y differing by under a meter) was enough to trigger a near-max correction.
    // Sweeping the gain against his actual steer_deg on that capture showed error dropping
    // monotonically as gain fell toward 0 (MAE 4.9deg at gain=10 vs 3.5deg at gain=0) --
    // i.e. this term was overpowering real turns' worth of correction on straight sidewalk.
    // Kept nonzero (not zeroed) because that capture had no real turn in it to confirm the
    // term still helps when a bend is genuinely there -- recapture on a curved stretch
    // before tuning this further.
    var _turn_gain = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_turn_anticipation_gain_deg_per_m) || 0;
    if (_turn_gain) {
        var _turn_max = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_turn_anticipation_max_deg) || 10;
        var _bias_left_y, _bias_right_y;
        // Bug fixed 2026-07-01: this used to test edge_left_x/edge_right_x for null here,
        // but by this point the default-substitution above has already replaced any null
        // with +-0.1, so the check was always true and the single-lost-edge branch below
        // was dead code. Use the booleans captured before that substitution instead.
        if (_had_left_edge && _had_right_edge) {
            _bias_left_y = edge_left_y;
            _bias_right_y = edge_right_y;
        } else {
            var _lost_recede_m = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_lost_recede_m) || 0.5;
            if (_had_left_edge) {
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

    // Safety feature to prevent Noah from over-steering and tipping over: no wheel should
    // ever be commanded past 14 degrees. steering_angle_deg here is the bicycle-model input
    // to calc_steering_and_rpm's Ackermann conversion, NOT a wheel angle -- that conversion
    // always turns the inner wheel sharper than this input (wheelbase_in=13, track_width_in=14.5
    // there). Clamping this input at 14 let the inner wheel reach ~19deg, a 36% overshoot past
    // the intended limit -- confirmed on Noah's own capture (logger/2026-07-01/14/rc_edge_capture_1,
    // 2026-07-01): every tick pinned at this clamp showed a wheel at 19.05deg, and the driver felt
    // it as a sudden, sharp, seemingly-out-of-nowhere steer. 11.04deg is the bicycle-model input
    // that makes the tightest (inner) wheel land at exactly 14deg -- recompute this if
    // wheelbase_in/track_width_in in calc_steering_and_rpm.js ever change.
    if (white_rabbit.motor.steering_angle_deg > 11.04) white_rabbit.motor.steering_angle_deg = 11.04;
    if (white_rabbit.motor.steering_angle_deg < -11.04) white_rabbit.motor.steering_angle_deg = -11.04;

    //return carrot steering angle to follow the carrot........
    return white_rabbit.motor.steering_angle_deg;




};
module.exports = carrot;