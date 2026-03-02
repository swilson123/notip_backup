var calculate_bearing = function () {};

calculate_bearing.prototype.toRadians = function (degrees) {
	return (degrees * Math.PI) / 180;
};

calculate_bearing.prototype.toDegrees = function (radians) {
	return (radians * 180) / Math.PI;
};

calculate_bearing.prototype.bearing = function (rover, startLat, startLng, destLat, destLng, units) {
	startLat = rover.calculate_bearing.toRadians(startLat);
	startLng = rover.calculate_bearing.toRadians(startLng);
	destLat = rover.calculate_bearing.toRadians(destLat);
	destLng = rover.calculate_bearing.toRadians(destLng);

	y = Math.sin(destLng - startLng) * Math.cos(destLat);
	x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
	brng = Math.atan2(y, x);

	if (units == 'radians') {
		return brng;
	} else {
		brng = rover.calculate_bearing.toDegrees(brng);
		return (brng + 360) % 360;
	}
};

module.exports = new calculate_bearing();
