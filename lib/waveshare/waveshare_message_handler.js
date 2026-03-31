
var waveshare_message_handler = function (rover, data) {

	const payload = (typeof data === 'string') ? data : JSON.stringify(data);
	rover.logs.waveshare_message_handler.log(rover, 'Received data: ' + payload);
};

module.exports = waveshare_message_handler;