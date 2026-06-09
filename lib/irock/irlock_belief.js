'use strict';

// Noah's remembered sense of where the light is.
//
// When the IRLock beacon blinks, Noah doesn't steer blind-center. He remembers
// the last known angle_x, then compass-compensates it for any yaw that happened
// while the light was out. When the light comes back, it snaps straight back in
// — right where Noah expected it.
//
// Coordinate convention matches irlock_message_handler.js:
//   angle_x > 0  → beacon right of camera bore (camera faces rearward)
//   angle_x < 0  → beacon left of camera bore
//
// Compass compensation:
//   If Noah yaws clockwise by ΔH degrees (heading increases), the beacon (fixed
//   in space) appears to shift ΔH degrees to the LEFT of the camera bore.
//   Therefore: new_believed_x = old_believed_x - ΔH

const HOLD_MS     = 2500;    // keep the believed angle this long after last detection
const BLEND_ALPHA = 0.40;    // how quickly fresh detections blend into the belief
const FOV_CLAMP   = 30;      // IRLock horizontal half-FOV in degrees

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
}

let _believed_x    = null;
let _believed_y    = null;
let _last_seen_ts  = null;
let _last_seen_hdg = null;

var irlock_belief = function (white_rabbit) {

    const target = white_rabbit.irlock && white_rabbit.irlock.target;
    const now    = Date.now();
    const hdg    = white_rabbit.get_heading(white_rabbit);

    if (target && typeof target.angle_x === 'number') {

        // Light is visible — blend fresh reading into the belief.
        if (_believed_x === null) {
            _believed_x = target.angle_x;
            _believed_y = target.angle_y;
        } else {
            _believed_x = _believed_x * (1 - BLEND_ALPHA) + target.angle_x * BLEND_ALPHA;
            _believed_y = _believed_y * (1 - BLEND_ALPHA) + target.angle_y * BLEND_ALPHA;
        }
        _last_seen_ts  = now;
        _last_seen_hdg = typeof hdg === 'number' ? hdg : _last_seen_hdg;

    } else if (_last_seen_ts !== null && (now - _last_seen_ts) < HOLD_MS) {

        // Light is out but the belief is still within the hold window.
        // Compass-compensate: account for any yaw since the light was last seen
        // so the believed angle stays accurate even if Noah has turned slightly.
        if (_last_seen_hdg !== null && typeof hdg === 'number') {
            const delta_hdg = signed_diff(hdg, _last_seen_hdg);
            _believed_x    -= delta_hdg;
            _believed_x     = Math.max(-FOV_CLAMP, Math.min(FOV_CLAMP, _believed_x));
            _last_seen_hdg  = hdg;   // advance so each tick applies only the incremental yaw
        }

    } else if (_last_seen_ts !== null) {

        // Belief window expired — clear it so follow_the_light falls through to search.
        _believed_x = null;
        _believed_y = null;

    }

    // Publish so follow_the_light.js can read without re-running the math.
    if (white_rabbit.irlock) {
        white_rabbit.irlock.believed_x      = _believed_x;
        white_rabbit.irlock.believed_y      = _believed_y;
        white_rabbit.irlock.believed_age_ms = _last_seen_ts ? now - _last_seen_ts : null;
    }

};

// Reset at dock-cycle start — stale belief from a previous run should not
// steer Noah toward a direction the light is no longer at.
irlock_belief.reset = function () {
    _believed_x    = null;
    _believed_y    = null;
    _last_seen_ts  = null;
    _last_seen_hdg = null;
};

module.exports = irlock_belief;
