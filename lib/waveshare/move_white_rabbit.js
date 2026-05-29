var move_white_rabbit = function (white_rabbit, motor_id, motor_speed_cmd, trigger) {
	//console.log('Moving white_rabbit - '+trigger+': ', motor_id, motor_speed_cmd);
	if (white_rabbit.motor.motor_type === "ZLAC8015D") {

		if (white_rabbit.zling.comName1_connected && white_rabbit.zling.comName2_connected) {
			white_rabbit.waveshare.connected = true;
			var message = { "T": 10010, "id": motor_id, "cmd": white_rabbit.calc_motor_rpm_value(white_rabbit, motor_speed_cmd), "act": 3 };
			white_rabbit.create_waveshare_message(white_rabbit, message);
		}
		else {
			console.log('Motor drivers not connected');
		}

	}
	else {
		if (white_rabbit.waveshare.connected) {
	
			var message = { "T": 10010, "id": motor_id, "cmd": white_rabbit.calc_motor_rpm_value(white_rabbit, motor_speed_cmd), "act": 3 };

			white_rabbit.create_waveshare_message(white_rabbit, message);
		} else {
			console.log('Waveshare not connected');
		}
	}
};


module.exports = move_white_rabbit;