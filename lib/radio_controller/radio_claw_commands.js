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

var radio_claw_commands = function (rover, message) {

	//console.log("rc: ", message);


	if (message.chan7_raw > 1900 && rover.claw.rc_claw != message.chan7_raw) {
		//Manual Claw Control...............................................................
		rover.claw.rc_claw = message.chan7_raw;
		console.log("RC Claw Manual Control Activated");
	}
	else if (message.chan7_raw < 1100 && rover.claw.rc_claw != message.chan7_raw) {
		//Auto Claw Control
		rover.claw.rc_claw = message.chan7_raw;

		//send arduino command to auto delivery....
		console.log("Send arduino command to auto delivery");
		rover.create_arduino_message(rover, 'deliver_package', 0);


	}
	else if (rover.claw.rc_claw != message.chan7_raw) {
		//RC Claw Off
		rover.claw.rc_claw = message.chan7_raw;
		console.log("RC Claw Off");

	}

	//Manual Claw Control Activated..........................................................
	if (rover.claw.rc_claw > 1900) {


		//Actuator Control............
		if (rover.claw.rc_actuator != message.chan8_raw) {
			rover.claw.rc_actuator = message.chan8_raw;
			//send arduino command to command actuator
			console.log("Send arduino arm command");
			rover.create_arduino_message(rover, 'arm', convertActuatorValue(rover.claw.rc_actuator));
		}



		//Belt Control............
		if (rover.claw.rc_belt != message.chan12_raw) {
			rover.claw.rc_belt = message.chan12_raw;
			//send arduino command to command belt
			console.log("Send arduino belt command");
			rover.create_arduino_message(rover, 'belt', rover.claw.rc_belt);
		}

	}

};


module.exports = radio_claw_commands;