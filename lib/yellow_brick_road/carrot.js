var carrot = function (white_rabbit) {

    //carrot the goal of this function is to use edge left XY and edge right XY to provide Noah a carrot to follow.
    //this carrot is what guides noah down the yellow_brick_road.
    //Keep Noah always facing forward on the sidewalk is key.

    // Captured before this tick overwrites steering_angle_deg, so the rate limiter at the
    // bottom of this function knows what Noah was actually commanded last tick.
    var _prev_steering_angle_deg = (typeof white_rabbit.motor.steering_angle_deg === 'number') ? white_rabbit.motor.steering_angle_deg : 0;

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

    // Updates white_rabbit.motor.carrot_bias_m -- a slow, multi-tick estimate of the
    // standing left/right calibration bias in the raw edge readings. See
    // carrot_data_filter.js for why a single-tick reactive formula can't see this on
    // its own (Noah hugging one side on both legs of the same trip).
    white_rabbit.carrot_data_filter(white_rabbit);

    //carrot STEERING...................................................................
    //steering angle is based on the difference between the left and right edge x coordinates.  If the left edge is further to the left than the right edge, the steering angle will be negative (left turn).  If the right edge is further to the right than the left edge, the steering angle will be positive (right turn).

    // Target point construction, rewritten 2026-07-01. Previously a missing edge was
    // replaced with a FAKE edge at +-0.1m so the centerline average always had two terms
    // (see git history) -- a constant with no physical meaning, much closer to center than
    // any real detected edge (0.3-0.9m in practice), which produced a large, arbitrary
    // swing in carrot_x_m the instant an edge dropped out. That also forced carrot_y_m
    // to average a real y with a phantom 0, halving it and roughly doubling the resulting
    // steering angle on every dropout (the "9/49 ticks pinned to +-14deg" bug fixed
    // earlier the same day). edge_side_offset_m already exists in setup.json for exactly
    // this situation -- CLAUDE.md documents the intended design ("left-only -> 1.5 ft
    // right of it, right-only -> 1.5 ft left of it") -- but carrot.js never used it.
    // Confirmed on Noah's own capture (logger/2026-07-01/15/rc_edge_capture_1): swapping
    // the +-0.1 hack for this offset-based target roughly halved the carrot_x_m jump at
    // every observed edge-dropout transition. No fabricated edges, no magic constants
    // disconnected from anything physical -- just the real, measured edge(s) plus one
    // already-tuned config value.
    var _side_offset_m = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_side_offset_m) || 0.5;
    var carrot_x_m, carrot_y_m;
    if (_had_left_edge && _had_right_edge) {
        carrot_x_m = (edge_left_x + edge_right_x) / 2;
        carrot_y_m = (edge_left_y + edge_right_y) / 2;
    } else if (_had_left_edge) {
        // Only the left edge visible -- aim edge_side_offset_m to the RIGHT of it, at
        // its own real forward distance.
        carrot_x_m = edge_left_x + _side_offset_m;
        carrot_y_m = edge_left_y;
    } else if (_had_right_edge) {
        // Only the right edge visible -- aim edge_side_offset_m to the LEFT of it.
        carrot_x_m = edge_right_x - _side_offset_m;
        carrot_y_m = edge_right_y;
    } else {
        // Neither edge visible -- carrot_has_edge is already false, so
        // follow_the_yellow_brick_road.js won't act on this tick's angle anyway.
        carrot_x_m = 0;
        carrot_y_m = 0;
    }

    // Subtract the slow multi-tick bias estimate from carrot_data_filter.js -- shifts
    // the target back toward Noah's TRUE center instead of the camera's own (possibly
    // miscalibrated) x=0. Applies uniformly across all three branches above: the bias
    // is a property of the sensor/mounting, not of which edge(s) happen to be visible
    // this tick.
    carrot_x_m -= (white_rabbit.motor.carrot_bias_m || 0);
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
        // but back then a default-substitution ran earlier in the function and replaced
        // any null with +-0.1 before this code ran, so the check was always true and the
        // single-lost-edge branch below was dead code. That substitution is gone now (see
        // the target-point construction above), but _had_left_edge/_had_right_edge are
        // kept as the explicit source of truth here rather than re-testing
        // edge_left_x/edge_right_x directly, so this block can't regress the same way if
        // that construction changes again later.
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

    // carrot_heading_deg is the whole idea in one line: the heading to the carrot point,
    // relative to whichever way Noah is currently facing (carrot_x_m/carrot_y_m are already
    // in Noah's own body frame, so this needs no GPS or compass round-trip). Point Noah at
    // this heading and it walks the carrot down -- everything below this line (turn_bias,
    // edge_steer_gain, the wheel-safety clamp, the rate limiter) exists only to compensate
    // for camera noise and hardware limits, not to compute where the carrot is.
    white_rabbit.motor.carrot_heading_deg = Math.atan2(carrot_x_m, carrot_y_m) * (180 / Math.PI);

    white_rabbit.motor.steering_angle_raw = white_rabbit.motor.carrot_heading_deg + _turn_bias_deg;

    // Magnitude-based steering_tune table removed 2026-07-01 (was: 0.50x under 9deg, ramping
    // to 1.00x at 18deg+). Added earlier to fight over-steering, but its shape worked against
    // that goal -- it barely touched the biggest, most dangerous swings while cutting small,
    // likely-legitimate corrections in half. It looked like it helped only because the real
    // causes (dead turn-bias code, halved carrot_y_m, fabricated +-0.1 edge -- all fixed
    // above/earlier the same day) were inflating angles into the range this table happened to
    // discount. The rate limiter below bounds how FAST steering_angle_deg can swing tick to
    // tick, but not how far it settles -- with the table gone, moderate corrections now pass
    // through at full strength (mean |angle| rose from 2.60deg to 3.80deg on Noah's own
    // capture), which turned out to feed a real feedback loop: a bigger sustained turn
    // physically rotates Noah's body enough to swing the camera off the opposite edge, which
    // the formula then reacts to with another big correction the other way -- 22/242 ticks in
    // logger/2026-07-01/16/rc_edge_capture_1 pinned the 11.04deg clamp. A single flat gain
    // (in place of the old graduated table) is the simplest fix: cuts every angle down evenly
    // instead of shaping small vs. large ones differently, so there's less total turn to
    // physically overshoot with in the first place. Tune edge_steer_gain in setup.json --
    // lower = calmer/less turn authority, 1.0 = today's raw (pre-tune-table) behavior.
    //
    // edge_steer_gain raised 0.5 -> 1.0 on 2026-07-03: Noah was observed (LCD live readout,
    // confirmed against logger/2026-07-03/3/follow_the_yelow_bick_road) hugging the left
    // side of the sidewalk with the heading-vs-carrot_target_hdg log showing correction
    // present but weak -- across 412 ticks, commanded steering_angle_deg never once
    // exceeded 5deg even while the heading error reached 15.9deg. At 0.5x gain the
    // correction was too small to ever close a real gap, let alone execute a curb turn in
    // the short distance edge_lookahead_m gives it. The wheel-safety clamp two lines below
    // still bounds the worst case regardless of this gain.
    var _steer_gain = (white_rabbit.realsense.vision_full && typeof white_rabbit.realsense.vision_full.edge_steer_gain === 'number')
        ? white_rabbit.realsense.vision_full.edge_steer_gain : 0.5;
    white_rabbit.motor.steering_angle_deg = white_rabbit.motor.steering_angle_raw * _steer_gain;

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

    // Rate limit: cap how much steering_angle_deg can move from the previous tick, added
    // 2026-07-01. Each tick recomputes this angle from a single fresh camera frame with no
    // memory of the last one, and confidence sits right on the 0.45 gate often enough that an
    // edge flickers in and out of the math tick to tick -- a normal, expected camera artifact,
    // not a real change in the sidewalk. On Noah's own capture (logger/2026-07-01/15/
    // rc_edge_capture_1) that produced a mean tick-to-tick swing of 2.67deg (max 17.60deg)
    // driving autonomously, versus 0.73deg (max 5.00deg) when Scott drove the same kind of
    // sidewalk by hand -- a human's eyes integrate over time and never react to one frame;
    // this rate limit is the closest cheap equivalent for the formula. Does not change the
    // steering math itself, only how fast its output is allowed to move.
    //
    // edge_steer_max_delta_deg_per_tick raised 3 -> 6 on 2026-07-03, alongside the
    // edge_steer_gain increase above -- same root cause (correction too weak/slow to reach
    // the wheel-safety clamp before a curb was already missed). Still a hard cap, not a
    // return to the old uncapped/oscillating behavior: at 6deg/tick it takes 2 ticks (0.5s)
    // to reach the 11.04deg clamp from a standing start instead of 4 (1s).
    var _max_delta_deg = (white_rabbit.realsense.vision_full && white_rabbit.realsense.vision_full.edge_steer_max_delta_deg_per_tick) || 3;
    if (white_rabbit.motor.steering_angle_deg - _prev_steering_angle_deg > _max_delta_deg) {
        white_rabbit.motor.steering_angle_deg = _prev_steering_angle_deg + _max_delta_deg;
    } else if (white_rabbit.motor.steering_angle_deg - _prev_steering_angle_deg < -_max_delta_deg) {
        white_rabbit.motor.steering_angle_deg = _prev_steering_angle_deg - _max_delta_deg;
    }

    //return carrot steering angle to follow the carrot........
    return white_rabbit.motor.steering_angle_deg;




};
module.exports = carrot;