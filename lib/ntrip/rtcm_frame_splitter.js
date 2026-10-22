//Splits a raw byte stream into complete, CRC-checked RTCM3 frames.
//RTCM3 frame: [0xD3][6 reserved bits + 10 bit length][payload][CRC-24Q, 3 bytes]
var RTCM_PREAMBLE = 0xD3;

var crc24q = function (buf, start, end) {
	var crc = 0;
	for (var i = start; i < end; i++) {
		crc ^= buf[i] << 16;
		for (var j = 0; j < 8; j++) {
			crc <<= 1;
			if (crc & 0x1000000) {
				crc ^= 0x1864CFB;
			}
		}
	}
	return crc & 0xFFFFFF;
};

//Checks the frame at the start of buf. Returns its length, 0 if more bytes are needed, -1 if it's not a frame.
var frame_length = function (buf) {
	if (buf[0] !== RTCM_PREAMBLE) {
		return -1;
	}
	if (buf.length < 3) {
		return 0;
	}
	if (buf[1] & 0xFC) {
		//reserved bits must be zero - not a real frame start
		return -1;
	}

	var payload_length = ((buf[1] & 0x03) << 8) | buf[2];
	if (buf.length < payload_length + 6) {
		return 0;
	}
	if (crc24q(buf, 0, payload_length + 3) !== buf.readUIntBE(payload_length + 3, 3)) {
		return -1;
	}
	return payload_length + 6;
};

var rtcm_frame_splitter = function () {
	var buf = Buffer.alloc(0);

	return {
		push: function (data) {
			var frames = [];
			buf = Buffer.concat([buf, data]);

			while (buf.length > 0) {
				if (buf[0] !== RTCM_PREAMBLE) {
					var start = buf.indexOf(RTCM_PREAMBLE);
					buf = start === -1 ? Buffer.alloc(0) : buf.slice(start);
					continue;
				}

				var length = frame_length(buf);
				if (length === 0) {
					break;
				}
				if (length < 0) {
					buf = buf.slice(1);
					continue;
				}

				frames.push(Buffer.from(buf.slice(0, length)));
				buf = buf.slice(length);
			}

			return frames;
		}
	};
};

rtcm_frame_splitter.RTCM_PREAMBLE = RTCM_PREAMBLE;
rtcm_frame_splitter.frame_length = frame_length;


module.exports = rtcm_frame_splitter;
