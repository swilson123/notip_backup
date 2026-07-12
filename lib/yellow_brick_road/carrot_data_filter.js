// carrot_data_filter -- tracks a slow-moving estimate of the persistent left/right
// calibration bias in the camera's own edge readings, so carrot.js can correct for it.
//
// Added 2026-07-03 after Noah was observed hugging the left side of the sidewalk on
// BOTH the outbound and return legs -- the same direction in Noah's own body frame
// regardless of which way it was actually facing, which rules out a real feature of
// the physical sidewalk and points at a standing bias in Noah's own perception/control
// (camera mounting, wheel alignment, etc.) that a pure per-tick reactive formula can
// never fully cancel: a proportional-only controller settles into an EQUILIBRIUM where
// its correction exactly balances the bias, holding a steady offset instead of
// converging to zero. Confirmed on Noah's own capture (logger/2026-07-03/2/
// rc_edge_capture_1, 186 autonomous ticks, both edges visible 100% of the time): mean
// |edge_left_x_m|=0.43, mean |edge_right_x_m|=0.58 -- a persistent ~0.15m asymmetry --
// with steering positive (turning right, correctly fighting it) on 74% of ticks and
// never fully closing the gap.
//
// Fix: track the SLOW rolling average of the raw midpoint x (only when both edges are
// confidently visible, so the single-edge fallback math in carrot.js doesn't pollute
// the estimate), and let carrot.js subtract that average from every tick's target --
// the "multiple ticks" signal a purely reactive per-tick formula can't see on its own.
// Same three tuning constants this used to read from realsense_vision.* in setup.json,
// baked in at their last-configured values now that section was trimmed down to only
// what the camera connection itself needs. See CLAUDE.md's realsense_vision note.
var CONFIDENCE_THRESHOLD = 0.45;
var CARROT_BIAS_ALPHA = 0.02;
var CARROT_BIAS_CAP_M = 0.2;

var carrot_data_filter = function (white_rabbit) {
    // Same confidence gate carrot.js applies -- re-derived here rather than passed in,
    // so this stays a single-white_rabbit-argument module like the rest of the codebase.
    var had_left_edge = white_rabbit.realsense.path_detection.edge_left_conf >= CONFIDENCE_THRESHOLD;
    var had_right_edge = white_rabbit.realsense.path_detection.edge_right_conf >= CONFIDENCE_THRESHOLD;
    if (!(had_left_edge && had_right_edge)) return;

    var raw_midpoint_x_m = (white_rabbit.realsense.path_detection.edge_left_x_m + white_rabbit.realsense.path_detection.edge_right_x_m) / 2;

    // Small alpha on purpose -- this should move over tens/hundreds of ticks (a real,
    // standing calibration bias), not react to any one moment the way carrot.js's own
    // per-tick steering already does.
    var alpha = CARROT_BIAS_ALPHA;

    if (typeof white_rabbit.motor.carrot_bias_m !== 'number') {
        white_rabbit.motor.carrot_bias_m = raw_midpoint_x_m;
    } else {
        white_rabbit.motor.carrot_bias_m += alpha * (raw_midpoint_x_m - white_rabbit.motor.carrot_bias_m);
    }

    // Cap added 2026-07-03: this filter can't tell the difference between "a fixed
    // sensor/mounting bias" (should be cancelled) and "Noah is currently off-center and
    // hasn't been corrected yet" (should NOT be cancelled -- that's the exact signal
    // carrot.js needs to steer back). Left uncapped, a persistent uncorrected drift would
    // slowly get learned as "normal" and silently subtracted out, cancelling the real
    // correction along with it -- Noah stops turning even while visibly off-center. The
    // original measured bias (logger/2026-07-03/2/rc_edge_capture_1) was ~0.15m; capping
    // at 0.2m leaves room to fully correct that while still blocking runaway cancellation.
    var _bias_cap_m = CARROT_BIAS_CAP_M;
    if (white_rabbit.motor.carrot_bias_m > _bias_cap_m) white_rabbit.motor.carrot_bias_m = _bias_cap_m;
    if (white_rabbit.motor.carrot_bias_m < -_bias_cap_m) white_rabbit.motor.carrot_bias_m = -_bias_cap_m;
};
module.exports = carrot_data_filter;
