//Build an NMEA GGA sentence for the NTRIP caster - VRS mount points need Noah's position to make the corrections.
//Position comes from the Pixhawk's GPS_RAW_INT (same builder as notip_car).
var GPS_STALE_MS = 3000;

var pad = function (n, width) {
	var s = String(n);
	while (s.length < width) {
		s = '0' + s;
	}
	return s;
};

var nmea_coordinate = function (degrees, deg_width) {
	var abs = Math.abs(degrees);
	var d = Math.floor(abs);
	var minutes = (abs - d) * 60;
	return pad(d, deg_width) + (minutes < 10 ? '0' : '') + minutes.toFixed(6);
};

var create_gga = function (p) {
	var body = 'GPGGA,' +
		pad(p.hour, 2) + pad(p.min, 2) + pad(p.sec, 2) + '.00,' +
		nmea_coordinate(p.lat, 2) + ',' + (p.lat >= 0 ? 'N' : 'S') + ',' +
		nmea_coordinate(p.lon, 3) + ',' + (p.lon >= 0 ? 'E' : 'W') + ',' +
		p.quality + ',' + pad(Math.min(p.num_sv, 99), 2) + ',' + p.hdop.toFixed(1) + ',' +
		p.hmsl_m.toFixed(3) + ',M,' + p.geoid_sep_m.toFixed(3) + ',M,,';

	var cs = 0;
	for (var i = 0; i < body.length; i++) {
		cs ^= body.charCodeAt(i);
	}
	return '$' + body + '*' + pad(cs.toString(16).toUpperCase(), 2) + '\r\n';
};

var update_ntrip_location = function (white_rabbit) {
	var gps = white_rabbit.robot_data.GPS_RAW_INT;

	if (!gps.time || Date.now() - gps.time > GPS_STALE_MS || gps.fix_type < 3) {
		return;
	}

	//GPS_RAW_INT fix_type: 4 DGPS, 5 RTK float, 6 RTK fixed -> GGA quality 2, 5, 4
	var t = new Date();
	white_rabbit.ntrip.GGA = create_gga({
		hour: t.getUTCHours(), min: t.getUTCMinutes(), sec: t.getUTCSeconds(),
		lat: gps.lat / 1e7,
		lon: gps.lon / 1e7,
		quality: gps.fix_type === 6 ? 4 : (gps.fix_type === 5 ? 5 : (gps.fix_type === 4 ? 2 : 1)),
		num_sv: gps.satellites_visible,
		hdop: gps.eph && gps.eph !== 65535 ? gps.eph / 100 : 1.0,
		hmsl_m: gps.alt / 1000,
		geoid_sep_m: 0,
	});
};


module.exports = update_ntrip_location;
