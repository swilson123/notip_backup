


var connect_to_waveshare = function (rover) {

	if (rover.motor.motor_type === "ZLAC8015D") {


		//Motor Driver 1.....................................................


		async function connect_to_motor_driver1() {

			if (!rover.zling.comName1_connected) {
				rover.motor.motor1_client = new rover.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await rover.motor.motor1_client.connectRTUBuffered(rover.zling.comName1, { baudRate: rover.zling.baudrate });
					rover.motor.motor1_client.setID(rover.zling.slave1_Id);



// 2. Initialization Sequence with delays
				await new Promise(r => setTimeout(r, 100));
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_OP_MODE, 3);      // Set Velocity Mode
				await new Promise(r => setTimeout(r, 100));
					await rover.motor.motor1_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x08); // Enable Driver


					if (rover.motor.motor1_client._port._id) {
						rover.zling.comName1_connected = true;
						console.log("Connected to ZLAC8015D Driver 1");
						console.log("Driver 1 Enabled in Velocity Mode");
					}
					else {
						console.log("Failed to connect to ZLAC8015D Driver 1");
					}





				} catch (e) {
					console.error("Communication DRIVER 1 Error:", e.message);
					rover.logs.connect_to_waveshare.log(rover, JSON.stringify(e.message));
				}
			}
		}

		connect_to_motor_driver1();

		//Motor Driver 2.....................................................


		async function connect_to_motor_driver2() {
			if (!rover.zling.comName2_connected) {
				rover.motor.motor2_client = new rover.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await rover.motor.motor2_client.connectRTUBuffered(rover.zling.comName2, { baudRate: rover.zling.baudrate });
					rover.motor.motor2_client.setID(rover.zling.slave2_Id);
					console.log("Initializing Motor 2 Client", rover.motor.motor2_client);


// 2. Initialization Sequence with delays
				await new Promise(r => setTimeout(r, 100));
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_OP_MODE, 3);      // Set Velocity Mode
				await new Promise(r => setTimeout(r, 100));
					await rover.motor.motor2_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x08); // Enable Driver


					if (rover.motor.motor2_client._port._id) {
						rover.zling.comName2_connected = true;

						console.log("Connected to ZLAC8015D Driver 2");
						console.log("Driver 2 Enabled in Velocity Mode");
					}
					else {
						console.log("Failed to connect to ZLAC8015D Driver 2");
					}

				} catch (e) {
					console.error("Communication DRIVER 2 Error:", e.message);
					rover.logs.connect_to_waveshare.log(rover, JSON.stringify(e.message));
				}
			}
		}

		connect_to_motor_driver2();





		// 4. Feedback Loop (Read every 500ms)
		const feedbackInterval = setInterval(async () => {

			if (rover.zling.comName1_connected) {
				try {
					if (!rover.motor.motor1_client) {
						console.warn("Motor 1 client not available");
						return;
					}
					// Read 2 registers starting from Left Feedback
					const res = await rover.motor.motor1_client.readHoldingRegisters(rover.zling.REG_L_FEEDBACK, 2);
					const leftSpeed = res.data[0];
					const rightSpeed = res.data[1];

					//console.log(`Current Speed -> Left: ${leftSpeed} RPM | Right: ${rightSpeed} RPM`);
				} catch (err) {
					console.error("Error reading Zling Com 1:", err.message);
					if (err.message.includes('CRC')) {
						console.warn("CRC error detected - check serial connection and baud rate");
					}
				}
			}

			if (rover.zling.comName2_connected) {
				try {
					if (!rover.motor.motor2_client) {
						console.warn("Motor 2 client not available");
						return;
					}
					// Read 2 registers starting from Left Feedback
					const res = await rover.motor.motor2_client.readHoldingRegisters(rover.zling.REG_L_FEEDBACK, 2);
					const leftSpeed = res.data[0];
					const rightSpeed = res.data[1];

					//console.log(`Current Speed -> Left: ${leftSpeed} RPM | Right: ${rightSpeed} RPM`);
				} catch (err) {
					console.error("Error reading Zling Com 2:", err.message);
					if (err.message.includes('CRC')) {
						console.warn("CRC error detected - check serial connection and baud rate");
					}
				}
			}
		}, 500);

		// Zling Motor Test (uncomment to run)....................................
		//rover.zling_motor_test(rover);

	}
	else if (rover.motor.motor_type === "DDSM115") {
		if (rover.waveshare.port_path && !rover.waveshare.connected) {
			rover.waveshare.serial = new rover.SerialPort({
				path: rover.waveshare.port_path,
				baudRate: rover.waveshare.baudrate,
			});

			//When port is open
			rover.waveshare.serial.on('open', function () {

				console.log("Waveshare Port is open");
				rover.waveshare.connected = true;


				rover.waveshare.serial.write('EN1\r\n');



				// Raw data listener to parse 10-byte DDSM frames and emit 'feedback'
				rover.waveshare.serial.on('data', function (data) {
					console.log(data);
				});


				rover.waveshare.parser = rover.waveshare.serial.pipe(new rover.Readline(
					{
						delimiter: '\r\n'
					}));


				rover.waveshare.parser.on('data', function (input) {

					console.log('Waveshare Data:', input);


				});

				rover.waveshare.parser.on('error', function (e) {
					console.log('rover.waveshare.parser: ', e);

				});


			});


			rover.waveshare.serial.on('close', function (e) {
				rover.waveshare.connected = false;
				console.log("Waveshare Port closed: ", e);



			});

			rover.waveshare.serial.on('error', function (e) {

				if (e) {
					console.log("Waveshare Port error: ", e);

				}
			});

		}
		else {
			console.log('Missing waveshare port');

		}
	}
	else {
		console.log("Unsupported motor type: ", rover.motor.motor_type);
	}

	// Zling Motor Test (uncomment to run)....................................
	//rover.ddsm_motor_test(rover);

};


module.exports = connect_to_waveshare;