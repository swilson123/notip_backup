//Send one RTCM3 frame from Noah's own NTRIP into the Pixhawk as GPS_RTCM_DATA (same as Mission Planner's RTK inject).
//Frames over 180 bytes are split into up to 4 fragments: flags = fragmented bit | fragment id << 1 | sequence id << 3
var MAX_FRAGMENT_LENGTH = 180;
var MAX_FRAGMENTS = 4;

var send_fragment = function (white_rabbit, flags, chunk) {
	//jspack packs the data field from a string, one char per byte
	var request = new white_rabbit.mavlink.messages.gps_rtcm_data(flags, chunk.length, chunk.toString('latin1'));
	white_rabbit.send_pixhawk_command(white_rabbit, 'gps_rtcm_data', request);
};

var send_message = function (white_rabbit, data) {
	var seq = white_rabbit.ntrip.rtcm_seq;
	white_rabbit.ntrip.rtcm_seq = (white_rabbit.ntrip.rtcm_seq + 1) & 0x1F;

	if (data.length <= MAX_FRAGMENT_LENGTH) {
		send_fragment(white_rabbit, seq << 3, data);
		return;
	}

	var fragment = 0;
	for (var i = 0; i < data.length; i += MAX_FRAGMENT_LENGTH) {
		send_fragment(white_rabbit, 1 | (fragment << 1) | (seq << 3), data.slice(i, i + MAX_FRAGMENT_LENGTH));
		fragment++;
	}

	//ArduPilot only knows the message is complete when it sees a short fragment (or all 4)
	if (data.length % MAX_FRAGMENT_LENGTH === 0 && fragment < MAX_FRAGMENTS) {
		send_fragment(white_rabbit, 1 | (fragment << 1) | (seq << 3), Buffer.alloc(0));
	}
};

var send_rtcm_to_pixhawk = function (white_rabbit, frame) {
	if (!white_rabbit.pixhawk_port.connected) {
		return;
	}

	//ArduPilot streams the bytes straight into its GPS, so a frame too big for one GPS_RTCM_DATA set can go as several
	var max = MAX_FRAGMENT_LENGTH * MAX_FRAGMENTS;
	for (var i = 0; i < frame.length; i += max) {
		send_message(white_rabbit, frame.slice(i, i + max));
	}

	white_rabbit.ntrip.rtcm_sent++;
};


module.exports = send_rtcm_to_pixhawk;
