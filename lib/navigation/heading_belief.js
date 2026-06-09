'use strict';

// Noah's internal sense of direction.
//
// A person who blinks does not lose their place. If the compass jumps 20°
// for one tick — a manhole cover, a passing car, a power line — Noah stays
// on his path. Only a sustained, consistent change (a real turn) shifts his
// belief. This separates noise from truth.

const BLEND_ALPHA   = 0.20;   // drift rate toward truth when sensors agree
const MAX_AGREE_DEG = 15.0;   // delta within this = sensors agree → blend
const DOUBT_LIMIT   = 4;      // consecutive disagreements before accepting a new direction

let _believed    = null;
let _doubt_count = 0;

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
}

var heading_belief = function (white_rabbit) {

    var raw = white_rabbit.get_heading(white_rabbit);

    if (_believed === null) {
        _believed    = raw;
        _doubt_count = 0;
        return _believed;
    }

    var delta = signed_diff(raw, _believed);

    if (Math.abs(delta) <= MAX_AGREE_DEG) {
        // Sensors agree — gently drift toward truth.
        // A 10° jump becomes ~2° of correction on this tick, not 10°.
        _believed    = ((_believed + delta * BLEND_ALPHA) + 360) % 360;
        _doubt_count = 0;
    } else {
        // Sensors say something different — stay the course, accumulate doubt.
        // If the disagreement is sustained (real turn, not noise), accept it.
        _doubt_count++;
        if (_doubt_count >= DOUBT_LIMIT) {
            _believed    = raw;
            _doubt_count = 0;
        }
    }

    return _believed;

};

// Force-sync belief to a known-good heading.
// Call each tick during active 4-wheel yaw so the belief stays current without
// fighting the turn. When yaw ends, belief is at the exact post-turn heading
// with no discontinuity.
heading_belief.sync = function (raw) {
    _believed    = ((raw) + 360) % 360;
    _doubt_count = 0;
};

// Clear belief — re-initializes from the raw heading on the next call.
// Call after a large known-good heading change (e.g., first compass snap) so
// the new correct offset takes effect immediately.
heading_belief.reset = function () {
    _believed    = null;
    _doubt_count = 0;
};

module.exports = heading_belief;
