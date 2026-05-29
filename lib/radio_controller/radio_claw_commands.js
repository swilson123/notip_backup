// Convert RC actuator value (1050-1950) to 0-200 range
var convertActuatorValue = function (rcValue) {
	// Clamp value between 1050 and 1950
	var clampedValue = Math.max(1050, Math.min(1950, rcValue));
	// Map 1050-1950 to 0-200
	var converter_value = (clampedValue - 1050) * (200 / 900);

	if (converter_value < 5) {
		return 0;
	} else {
		return converter_value;
	}

};

var radio_claw_commands = function (white_rabbit, message) {

	//console.log("rc: ", message);


	if (message.chan5_raw > 1900 && white_rabbit.claw.rc_claw != message.chan5_raw) {
		//Manual Claw Control On...............................................................
		white_rabbit.claw.rc_claw = message.chan5_raw;
		console.log("RC Claw Manual Control Activated");
	}
	else if (message.chan5_raw < 1100 && white_rabbit.claw.rc_claw != message.chan5_raw) {
		//Manual Claw Control Off
		white_rabbit.claw.rc_claw = message.chan5_raw;

		console.log("Claw Off Auto Delivery Activated");
		

  //white_rabbit.create_arduino_message(white_rabbit, 'deliver_package', 0);
	}


	//Manual Claw Control Activated..........................................................
	if (white_rabbit.claw.rc_claw > 1900) {


		//Actuator Control............
		if (white_rabbit.claw.rc_actuator != message.chan8_raw) {
			white_rabbit.claw.rc_actuator = message.chan8_raw;
			//send arduino command to command actuator
			console.log("Send arduino arm command");
			white_rabbit.create_arduino_message(white_rabbit, 'arm', convertActuatorValue(white_rabbit.claw.rc_actuator));
		}

			if (white_rabbit.claw.rc_telescope != message.chan2_raw) {
			white_rabbit.claw.rc_telescope = message.chan2_raw;
			//send arduino command to command actuator
			console.log("Send arduino telescope command");
			white_rabbit.create_arduino_message(white_rabbit, 'telescope', convertActuatorValue(white_rabbit.claw.rc_telescope));
		}



		//Belt Control............
		if (white_rabbit.claw.rc_belt != message.chan12_raw) {
			white_rabbit.claw.rc_belt = message.chan12_raw;
			//send arduino command to command belt
			console.log("Send arduino belt command");
			white_rabbit.create_arduino_message(white_rabbit, 'belt', white_rabbit.claw.rc_belt);
		}

	}

};


module.exports = radio_claw_commands;