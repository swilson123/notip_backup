//Runs once a second. RTK correction priority, best first:
//  1. Noah's own NTRIP (Noah has internet) - straight into the Pixhawk
//  2. the car's NTRIP over the radio (car has internet)
//  3. the car's Here 4 base station over the radio (nobody has internet)
//The car decides 2 vs 3 and stays off the radio while Noah reports NTRIP_OK = 1 - two reference stations must never mix in one GPS.
//The car's NTRIP_EN (rtk_noah_ntrip on the car) can switch Noah's NTRIP off; with no car in range Noah's own setup decides.
//ORTN corrections have made positions worse in some places before: if they don't get Noah to RTK float/fixed within
//fix_timeout_seconds, Noah drops them, reports NTRIP_OK = 0 so the car takes over, and tries again after retry_seconds.
var RECONNECT_MS = 5000;
var STALE_MS = 15000;			//no bytes from the caster this long -> reconnect
var HEALTHY_MS = 5000;			//corrections within this long -> Noah's NTRIP is the active source
var LOCATION_UPDATE_MS = 10000;
var CAR_STALE_MS = 5000;		//car sends NTRIP_EN every second
var STATUS_LOG_MS = 5000;
var RTK_FLOAT = 5;

var FIX_NAMES = ['no GPS', 'no fix', '2D', '3D', 'DGPS', 'RTK float', 'RTK fixed', 'static', 'PPP'];

var send_ntrip_ok = function (white_rabbit) {
	if (!white_rabbit.pixhawk_port.connected || !white_rabbit.pixhawk_port.mavlink) {
		return;
	}

	var time_boot_ms = (Date.now() - white_rabbit.pixhawk_port.mavlink.startup_time) >>> 0;
	var request = new white_rabbit.mavlink.messages.named_value_int(time_boot_ms, 'NTRIP_OK', white_rabbit.ntrip.healthy ? 1 : 0);

	white_rabbit.send_pixhawk_command(white_rabbit, 'NTRIP_OK', request);
};

var ntrip_manager = function (white_rabbit) {
	if (!white_rabbit.logs.ntrip) {
		return;
	}

	var now = Date.now();
	var gps = white_rabbit.robot_data.GPS_RAW_INT;
	var car_says_off = white_rabbit.car.ntrip_en === 0 && now - white_rabbit.car.ntrip_en_time < CAR_STALE_MS;
	var waiting_to_retry = now - white_rabbit.ntrip.rtk_failed_time < white_rabbit.ntrip.retry_seconds * 1000;
	var wanted = white_rabbit.ntrip.enabled && !car_says_off && !waiting_to_retry;

	white_rabbit.update_ntrip_location(white_rabbit);

	white_rabbit.ntrip.healthy = wanted && white_rabbit.ntrip.connected && now - white_rabbit.ntrip.last_rtcm_time < HEALTHY_MS;

	if (white_rabbit.ntrip.healthy !== white_rabbit.ntrip.last_healthy) {
		white_rabbit.ntrip.last_healthy = white_rabbit.ntrip.healthy;
		var source_msg = 'RTK corrections now from: ' + (white_rabbit.ntrip.healthy ? 'Noah NTRIP' : 'car (NTRIP or Here 4 base)');
		white_rabbit.logs.ntrip.log(white_rabbit, source_msg);
		console.log(source_msg);
	}

	send_ntrip_ok(white_rabbit);

	//Accuracy record - compare sources by fix type and h_acc..........................
	if (now - white_rabbit.ntrip.last_status_log > STATUS_LOG_MS) {
		white_rabbit.ntrip.last_status_log = now;
		white_rabbit.logs.ntrip.log(white_rabbit, JSON.stringify({
			source: white_rabbit.ntrip.healthy ? 'noah_ntrip' : 'car',
			fix: FIX_NAMES[gps.fix_type] || gps.fix_type,
			h_acc_mm: gps.h_acc,
			sats: gps.satellites_visible,
			car_ntrip_en: white_rabbit.car.ntrip_en,
			bytes: white_rabbit.ntrip.bytes,
			rtcm_sent: white_rabbit.ntrip.rtcm_sent
		}));
	}

	if (!wanted) {
		if (white_rabbit.ntrip.client) {
			white_rabbit.logs.ntrip.log(white_rabbit, car_says_off ? 'NTRIP on Noah turned off by the car (NTRIP_EN = 0)' : 'NTRIP on Noah off');
			white_rabbit.ntrip.client.destroy();
		}
		return;
	}

	if (!white_rabbit.ntrip.client) {
		if (now - white_rabbit.ntrip.last_close_time > RECONNECT_MS) {
			white_rabbit.create_ntrip_client(white_rabbit);
		}
		return;
	}

	if (now - white_rabbit.ntrip.last_data_time > STALE_MS) {
		white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP stream went quiet, reconnecting');
		white_rabbit.ntrip.client.destroy();
		return;
	}

	//Do the corrections actually get Noah to RTK?...........................
	if (white_rabbit.ntrip.healthy && gps.fix_type >= RTK_FLOAT) {
		white_rabbit.ntrip.rtk_reached = true;
	}
	if (white_rabbit.ntrip.healthy && !white_rabbit.ntrip.rtk_reached && now - white_rabbit.ntrip.connected_time > white_rabbit.ntrip.fix_timeout_seconds * 1000) {
		var fail_msg = 'Noah NTRIP gave no RTK fix in ' + white_rabbit.ntrip.fix_timeout_seconds + 's (' + (FIX_NAMES[gps.fix_type] || gps.fix_type) +
			') - handing RTK to the car, retry in ' + white_rabbit.ntrip.retry_seconds + 's';
		white_rabbit.logs.ntrip.log(white_rabbit, fail_msg);
		console.log(fail_msg);
		white_rabbit.ntrip.rtk_failed_time = now;
		white_rabbit.ntrip.client.destroy();
		return;
	}

	//VRS mount points follow the rover - keep the caster up to date with where Noah is
	if (white_rabbit.ntrip.connected && white_rabbit.ntrip.GGA && now - white_rabbit.ntrip.last_location_update > LOCATION_UPDATE_MS) {
		white_rabbit.ntrip.client.write(white_rabbit.ntrip.GGA);
		white_rabbit.ntrip.last_location_update = now;
	}
};


module.exports = ntrip_manager;
