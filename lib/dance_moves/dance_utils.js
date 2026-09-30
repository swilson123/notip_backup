// Small shared helpers for the dance move files. Nothing here touches
// white_rabbit directly (no aliasing of white_rabbit.x.y.z — these are
// genuinely computed values: a delay promise and a wrapped angle delta).

var sleep = function (ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
};

// Signed shortest-path delta between two radian angles, wrapped to
// [-PI, PI]. Used to accumulate yaw progress across ticks the same way
// lib/voice/voice_manager.js's nudge_spin() does for ATTITUDE.yaw.
var signed_angle_delta_rad = function (from_rad, to_rad) {
	var d = to_rad - from_rad;
	if (d > Math.PI) d -= 2 * Math.PI;
	if (d < -Math.PI) d += 2 * Math.PI;
	return d;
};

module.exports = { sleep: sleep, signed_angle_delta_rad: signed_angle_delta_rad };
