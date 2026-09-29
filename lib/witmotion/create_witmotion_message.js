// Sends one command to the MJRTK-UM982.
//
// The UM982 takes plain ASCII commands terminated with CR/LF — no checksum, no framing. What
// you type into Unicore's own terminal is what goes on the wire:
//   'UNILOGLIST'         list what the receiver is currently emitting
//   'GPGGA 1'            emit $GNGGA at 1 Hz  (0 turns a message off)
//   'UNIHEADINGA 1'      emit the dual-antenna heading solution at 1 Hz — the compass message
//   'GPTHS 1'            heading in plain NMEA form, if you would rather parse that
//   'SAVECONFIG'         persist the current output set across power cycles
// Nothing is sent unless the port is open, and a failed write is logged rather than thrown, so a
// bad command can never take the mission loop down with it.

var create_witmotion_message = function (white_rabbit, message) {

	if (white_rabbit.witmotion.serial && white_rabbit.witmotion.connected) {
		try {
			// The receiver ignores any command that does not end in CR/LF, and a caller passing
			// one already terminated is the common case — so add it only when it is missing.
			const command = message.endsWith('\r\n') ? message : message + '\r\n';

			console.log('Sending to witmotion: ', message);
			white_rabbit.logs.witmotion_message_handler.log(white_rabbit, 'Sending to witmotion: ' + message);
			white_rabbit.witmotion.serial.write(command);
		} catch (e) {
			console.log(e);
			white_rabbit.logs.witmotion_message_handler.log(white_rabbit, 'Error writing to witmotion port: ' + e.message);
		}

	} else {
		console.log('witmotion Port not connected! Message failed to send:', message);
	}
};

module.exports = create_witmotion_message;
