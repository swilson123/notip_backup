var calculate_bearing = {};

calculate_bearing.toRadians = function (degrees) {
	return (degrees * Math.PI) / 180;
};

calculate_bearing.toDegrees = function (radians) {
	return (radians * 180) / Math.PI;
};

calculate_bearing.bearing = function (white_rabbit, startLat, startLng, destLat, destLng, units) {
	startLat = white_rabbit.calculate_bearing.toRadians(startLat);
	startLng = white_rabbit.calculate_bearing.toRadians(startLng);
	destLat = white_rabbit.calculate_bearing.toRadians(destLat);
	destLng = white_rabbit.calculate_bearing.toRadians(destLng);

	y = Math.sin(destLng - startLng) * Math.cos(destLat);
	x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
	brng = Math.atan2(y, x);

	if (units == 'radians') {
		return brng;
	} else {
		brng = white_rabbit.calculate_bearing.toDegrees(brng);
		return (brng + 360) % 360;
	}
};

module.exports = calculate_bearing;
