'use strict';

// Odometry-gated spatial edge trail.
//
// Commits one sample every edge_trail_sample_dist_m of wheel travel (default 10cm).
// Each sample is the AVERAGE of all camera frames in that distance window.
//
// Per-side consistency gate: if a side's averaged X or Y jumps more than
// edge_trail_max_x_jump_m / edge_trail_max_y_jump_m from the last committed sample,
// that side is rejected independently. The solid sidewalk doesn't teleport.
//
// Per-side streak counter: each clean commit increments the streak; each rejection
// resets it to zero. Streak → confidence (saturates at 1.0 after 5 clean samples).
// When one side is steady and the other is jumping, the streak makes that explicit
// so steering can always rely on the most trusted side.
//
// Key computed field:
//   left_abs_dist_m = dist_m + left_y_m   (world-path position, fixed at sample time)
// Effective lookahead: sample.left_abs_dist_m - white_rabbit.realsense.edge_trail_dist_m
// Positive = still ahead. Negative = Noah has already passed it.
//
// Sitting still: distance gate never opens. Correct — trail is spatial, not temporal.

var _last_odo    = null;
var _total_m     = 0;
var _last_sample = null;
var _streak      = { left: 0, right: 0 };
var _accum       = { lx: 0, ly: 0, lc: 0, rx: 0, ry: 0, rc: 0 };

function pulses_per_m(white_rabbit) {
    var vcfg = white_rabbit.voice_config || {};
    var diam = typeof vcfg.wheel_diameter_m === 'number' ? vcfg.wheel_diameter_m : 0.254;
    var cpr  = typeof vcfg.cpr_pulses_per_rev === 'number' ? vcfg.cpr_pulses_per_rev : 16385;
    return cpr / (Math.PI * diam);
}

function snapshot_odo(white_rabbit) {
    var p = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!p) return null;
    return { 1: p[1] | 0, 2: p[2] | 0, 3: p[3] | 0, 4: p[4] | 0 };
}

function delta_m(white_rabbit, prev) {
    var now_p = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!now_p || !prev) return 0;
    var sum = 0;
    for (var id = 1; id <= 4; id++) sum += Math.abs((now_p[id] | 0) - (prev[id] | 0));
    return (sum / 4) / pulses_per_m(white_rabbit);
}

// Streak → confidence: 0 clean commits = 0.0, 5+ clean commits = 1.0.
function streak_conf(streak) {
    return Math.min(1.0, streak / 5);
}

var edge_trail = function(white_rabbit, detection) {
    var cfg = (white_rabbit.setup && white_rabbit.setup.nav_tuning) || {};
    if (cfg.edge_trail_enabled === false) return;

    var sample_dist_m = typeof cfg.edge_trail_sample_dist_m === 'number' ? cfg.edge_trail_sample_dist_m : 0.10;
    var max_samples   = typeof cfg.edge_trail_max_samples   === 'number' ? cfg.edge_trail_max_samples   : 20;
    var max_x_jump    = typeof cfg.edge_trail_max_x_jump_m  === 'number' ? cfg.edge_trail_max_x_jump_m  : 0.20;
    var max_y_jump    = typeof cfg.edge_trail_max_y_jump_m  === 'number' ? cfg.edge_trail_max_y_jump_m  : 0.15;

    if (!Array.isArray(white_rabbit.realsense.edge_trail)) {
        white_rabbit.realsense.edge_trail = [];
    }

    if (!_last_odo) {
        _last_odo = snapshot_odo(white_rabbit);
        _total_m  = 0;
        _accum    = { lx: 0, ly: 0, lc: 0, rx: 0, ry: 0, rc: 0 };
        white_rabbit.realsense.edge_trail_dist_m = 0;
        return;
    }

    // Accumulate every incoming camera frame.
    if (detection) {
        if (detection.edge_left_known && typeof detection.edge_left_x_m === 'number' && typeof detection.edge_left_y_m === 'number') {
            _accum.lx += detection.edge_left_x_m;
            _accum.ly += detection.edge_left_y_m;
            _accum.lc++;
        }
        if (detection.edge_right_known && typeof detection.edge_right_x_m === 'number' && typeof detection.edge_right_y_m === 'number') {
            _accum.rx += detection.edge_right_x_m;
            _accum.ry += detection.edge_right_y_m;
            _accum.rc++;
        }
    }

    var traveled = delta_m(white_rabbit, _last_odo);
    white_rabbit.realsense.edge_trail_dist_m = parseFloat((_total_m + traveled).toFixed(3));

    if (traveled < sample_dist_m) return;

    _total_m += traveled;
    _last_odo = snapshot_odo(white_rabbit);

    var left_x_m     = _accum.lc > 0 ? _accum.lx / _accum.lc : null;
    var left_y_m     = _accum.lc > 0 ? _accum.ly / _accum.lc : null;
    var right_x_m    = _accum.rc > 0 ? _accum.rx / _accum.rc : null;
    var right_y_m    = _accum.rc > 0 ? _accum.ry / _accum.rc : null;
    var left_frames  = _accum.lc;
    var right_frames = _accum.rc;

    _accum = { lx: 0, ly: 0, lc: 0, rx: 0, ry: 0, rc: 0 };

    // Per-side consistency gate. Compare averaged values to last committed sample.
    // Rejection resets that side's streak to zero. Acceptance increments it.
    // Outer edge of a turn will either go out of frame (lc=0, not seen) or jump
    // and be rejected here. Inner edge stays steady — streak climbs, confidence rises.
    var left_ok  = left_x_m  !== null;
    var right_ok = right_x_m !== null;

    if (_last_sample) {
        if (left_ok && _last_sample.left_x_m !== null) {
            if (Math.abs(left_x_m  - _last_sample.left_x_m)  > max_x_jump ||
                Math.abs(left_y_m  - _last_sample.left_y_m)  > max_y_jump) {
                left_ok = false;
            }
        }
        if (right_ok && _last_sample.right_x_m !== null) {
            if (Math.abs(right_x_m - _last_sample.right_x_m) > max_x_jump ||
                Math.abs(right_y_m - _last_sample.right_y_m) > max_y_jump) {
                right_ok = false;
            }
        }
    }

    // Update streaks. A rejected or unseen side resets to zero.
    _streak.left  = left_ok  ? _streak.left  + 1 : 0;
    _streak.right = right_ok ? _streak.right + 1 : 0;

    if (!left_ok && !right_ok) return;   // both sides bad — skip sample

    var sample = {
        dist_m:           parseFloat(_total_m.toFixed(3)),

        left_x_m:         left_ok  ? parseFloat(left_x_m.toFixed(4))  : null,
        left_y_m:         left_ok  ? parseFloat(left_y_m.toFixed(3))  : null,
        left_abs_dist_m:  left_ok  ? parseFloat((_total_m + left_y_m).toFixed(3))  : null,
        left_known:       left_ok,
        left_frames:      left_ok  ? left_frames  : 0,
        left_streak:      _streak.left,
        left_confidence:  parseFloat(streak_conf(_streak.left).toFixed(2)),

        right_x_m:        right_ok ? parseFloat(right_x_m.toFixed(4)) : null,
        right_y_m:        right_ok ? parseFloat(right_y_m.toFixed(3)) : null,
        right_abs_dist_m: right_ok ? parseFloat((_total_m + right_y_m).toFixed(3)) : null,
        right_known:      right_ok,
        right_frames:     right_ok ? right_frames : 0,
        right_streak:     _streak.right,
        right_confidence: parseFloat(streak_conf(_streak.right).toFixed(2)),

        // Which side to trust right now. Higher streak wins.
        // Steering uses this so it never has to reason about the trail internals.
        trusted_side: (_streak.left >= _streak.right && left_ok)  ? 'left'
                    : (_streak.right > _streak.left  && right_ok) ? 'right'
                    : left_ok ? 'left' : 'right',

        ts: Date.now()
    };

    _last_sample = sample;

    white_rabbit.realsense.edge_trail.push(sample);

    while (white_rabbit.realsense.edge_trail.length > max_samples) {
        white_rabbit.realsense.edge_trail.shift();
    }
};

edge_trail.start = function() {
    _last_odo    = null;
    _total_m     = 0;
    _last_sample = null;
    _streak      = { left: 0, right: 0 };
    _accum       = { lx: 0, ly: 0, lc: 0, rx: 0, ry: 0, rc: 0 };
};

module.exports = edge_trail;
