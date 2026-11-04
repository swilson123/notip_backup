var coordinates_offset = function (distance_meters, Lat, Lng, degrees) {
	var radians = (degrees * Math.PI) / 180;
	var distanceNorth = Math.cos(radians) * distance_meters;
	var distanceEast = Math.sin(radians) * distance_meters;
	var earthRadius = 6371000;
	var newLat = Lat + ((distanceNorth / earthRadius) * 180) / Math.PI;
	var newLon = Lng + ((distanceEast / (earthRadius * Math.cos((newLat / 180) * Math.PI))) * 180) / Math.PI;

	return [newLat, newLon];

};

module.exports = coordinates_offset;
