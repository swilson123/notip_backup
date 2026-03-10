


var connect_to_waveshare = function (rover) {

	function withTimeout(promise, timeoutMs, label) {
		return Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
		]);
	}

	function toSigned16(value) {
		const normalized = value & 0xFFFF;
		return normalized > 0x7FFF ? normalized - 0x10000 : normalized;
	}

	function getLastZlingCommand(roverRef, motorId) {
		if (!roverRef || !roverRef.zling || !roverRef.zling.last_cmd_rpm_by_id) {
			return 0;
		}

		return roverRef.zling.last_cmd_rpm_by_id[motorId] || 0;
	}

	if (!rover.zling.health) {
		rover.zling.health = {
			driver1_consecutive_read_errors: 0,
			driver1_last_recovery_ts: 0,
			driver1_recovery_in_progress: false,
			driver2_consecutive_read_errors: 0,
			driver2_last_recovery_ts: 0,
			driver2_recovery_in_progress: false,
			stall_reads_by_motor_id: {
				1: 0,
				2: 0,
				3: 0,
				4: 0
			}
		};
	}

	if (!rover.zling.health.stall_reads_by_motor_id) {
		rover.zling.health.stall_reads_by_motor_id = { 1: 0, 2: 0, 3: 0, 4: 0 };
	}

	function detectWheelStall(roverRef, motorId, measuredRpmAbs) {
		const expectedRpmAbs = Math.abs(getLastZlingCommand(roverRef, motorId));
		const expectedThreshold = 120;
		const measuredThreshold = 40;

		if (expectedRpmAbs >= expectedThreshold && measuredRpmAbs <= measuredThreshold) {
			roverRef.zling.health.stall_reads_by_motor_id[motorId] += 1;
		} else {
			roverRef.zling.health.stall_reads_by_motor_id[motorId] = 0;
		}

		return {
			expectedRpmAbs,
			count: roverRef.zling.health.stall_reads_by_motor_id[motorId]
		};
	}

	if (rover.motor.motor_type === "ZLAC8015D") {


		//Motor Driver 1.....................................................


		async function connect_to_motor_driver1() {

			if (!rover.zling.comName1_connected) {
				rover.motor.motor1_client = new rover.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await rover.motor.motor1_client.connectRTUBuffered(rover.zling.comName1, { baudRate: rover.zling.baudrate });
					rover.motor.motor1_client.setID(rover.zling.slave1_Id);
					rover.motor.motor1_client.setTimeout(200);



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
					rover.motor.motor2_client.setTimeout(200);
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

		async function autoRecoverDriver1(reason) {
			if (!rover.motor.motor1_client) {
				return;
			}

			if (rover.zling.health.driver1_recovery_in_progress) {
				return;
			}

			const now = Date.now();
			const cooldownMs = 10000;
			if (now - rover.zling.health.driver1_last_recovery_ts < cooldownMs) {
				return;
			}

			rover.zling.health.driver1_recovery_in_progress = true;
			rover.zling.health.driver1_last_recovery_ts = now;
			console.warn("Driver 1 auto-recovery triggered:", reason);

			try {
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_L_TARGET_RPM, 0);
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_R_TARGET_RPM, 0);

				// Typical fault reset value; ignored if not supported by controller firmware.
				try {
					await rover.motor.motor1_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x80);
				} catch (resetError) {
					console.warn("Driver 1 fault-reset command not accepted:", resetError.message);
				}

				await new Promise(r => setTimeout(r, 100));
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_OP_MODE, 3);
				await new Promise(r => setTimeout(r, 100));
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x08);

				const lastFrontPassengerCmd = getLastZlingCommand(rover, 1);
				const lastFrontDriverCmd = getLastZlingCommand(rover, 3);

				await rover.motor.motor1_client.writeRegister(rover.zling.REG_R_TARGET_RPM, lastFrontPassengerCmd);
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_L_TARGET_RPM, lastFrontDriverCmd);

				console.log("Driver 1 auto-recovery completed");
				rover.zling.health.stall_reads_by_motor_id[1] = 0;
				rover.zling.health.stall_reads_by_motor_id[3] = 0;
				rover.zling.health.driver1_consecutive_read_errors = 0;
			} catch (recoveryError) {
				console.error("Driver 1 auto-recovery failed:", recoveryError.message);
			} finally {
				rover.zling.health.driver1_recovery_in_progress = false;
			}
		}

		async function autoRecoverDriver2(reason) {
			if (!rover.motor.motor2_client) {
				return;
			}

			if (rover.zling.health.driver2_recovery_in_progress) {
				return;
			}

			const now = Date.now();
			const cooldownMs = 10000;
			if (now - rover.zling.health.driver2_last_recovery_ts < cooldownMs) {
				return;
			}

			rover.zling.health.driver2_recovery_in_progress = true;
			rover.zling.health.driver2_last_recovery_ts = now;
			console.warn("Driver 2 auto-recovery triggered:", reason);

			try {
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_L_TARGET_RPM, 0);
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_R_TARGET_RPM, 0);

				// Typical fault reset value; ignored if not supported by controller firmware.
				try {
					await rover.motor.motor2_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x80);
				} catch (resetError) {
					console.warn("Driver 2 fault-reset command not accepted:", resetError.message);
				}

				await new Promise(r => setTimeout(r, 100));
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_OP_MODE, 3);
				await new Promise(r => setTimeout(r, 100));
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x08);

				const lastBackPassengerCmd = getLastZlingCommand(rover, 2);
				const lastBackDriverCmd = getLastZlingCommand(rover, 4);

				await rover.motor.motor2_client.writeRegister(rover.zling.REG_R_TARGET_RPM, lastBackPassengerCmd);
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_L_TARGET_RPM, lastBackDriverCmd);

				console.log("Driver 2 auto-recovery completed");
				rover.zling.health.stall_reads_by_motor_id[2] = 0;
				rover.zling.health.stall_reads_by_motor_id[4] = 0;
				rover.zling.health.driver2_consecutive_read_errors = 0;
			} catch (recoveryError) {
				console.error("Driver 2 auto-recovery failed:", recoveryError.message);
			} finally {
				rover.zling.health.driver2_recovery_in_progress = false;
			}
		}





		// 4. Feedback Loop (Read every 500ms)
		if (rover.zling._feedbackInterval) {
			clearInterval(rover.zling._feedbackInterval);
		}

		rover.zling._feedbackPollInProgress = false;

		rover.zling._feedbackInterval = setInterval(async () => {
			if (rover.zling._feedbackPollInProgress) {
				return;
			}

			rover.zling._feedbackPollInProgress = true;

			try {

			if (rover.zling.comName1_connected) {
				try {
					if (!rover.motor.motor1_client) {
						console.warn("Motor 1 client not available");
						return;
					}
					// Read 2 registers starting from Left Feedback
					const res = await withTimeout(
						rover.motor.motor1_client.readHoldingRegisters(rover.zling.REG_L_FEEDBACK, 2),
						350,
						'Driver 1 feedback read'
					);
					const leftSpeed = toSigned16(res.data[0]);
					const rightSpeed = toSigned16(res.data[1]);
					rover.zling.health.driver1_consecutive_read_errors = 0;

					// Motor mapping on driver 1: left feedback -> id 3, right feedback -> id 1
					const frontDriver = detectWheelStall(rover, 3, Math.abs(leftSpeed));
					const frontPassenger = detectWheelStall(rover, 1, Math.abs(rightSpeed));

					if (frontDriver.count >= 6) {
						autoRecoverDriver1(`wheel id 3 stalled while commanded ${frontDriver.expectedRpmAbs} RPM (feedback ${Math.abs(leftSpeed)} RPM)`);
					}

					if (frontPassenger.count >= 6) {
						autoRecoverDriver1(`wheel id 1 stalled while commanded ${frontPassenger.expectedRpmAbs} RPM (feedback ${Math.abs(rightSpeed)} RPM)`);
					}

					//console.log(`Current Speed -> Left: ${leftSpeed} RPM | Right: ${rightSpeed} RPM`);
				} catch (err) {
					console.error("Error reading Zling Com 1:", err.message);
					rover.zling.health.driver1_consecutive_read_errors += 1;
					if (rover.zling.health.driver1_consecutive_read_errors >= 4) {
						autoRecoverDriver1(`consecutive read errors (${rover.zling.health.driver1_consecutive_read_errors})`);
					}
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
					const res = await withTimeout(
						rover.motor.motor2_client.readHoldingRegisters(rover.zling.REG_L_FEEDBACK, 2),
						350,
						'Driver 2 feedback read'
					);
					const leftSpeed = toSigned16(res.data[0]);
					const rightSpeed = toSigned16(res.data[1]);

					rover.zling.health.driver2_consecutive_read_errors = 0;

					// Motor mapping on driver 2: left feedback -> id 4, right feedback -> id 2
					const backDriver = detectWheelStall(rover, 4, Math.abs(leftSpeed));
					const backPassenger = detectWheelStall(rover, 2, Math.abs(rightSpeed));

					if (backDriver.count >= 6) {
						autoRecoverDriver2(`wheel id 4 stalled while commanded ${backDriver.expectedRpmAbs} RPM (feedback ${Math.abs(leftSpeed)} RPM)`);
					}

					if (backPassenger.count >= 6) {
						autoRecoverDriver2(`wheel id 2 stalled while commanded ${backPassenger.expectedRpmAbs} RPM (feedback ${Math.abs(rightSpeed)} RPM)`);
					}

					//console.log(`Current Speed -> Left: ${leftSpeed} RPM | Right: ${rightSpeed} RPM`);
				} catch (err) {
					console.error("Error reading Zling Com 2:", err.message);
					rover.zling.health.driver2_consecutive_read_errors += 1;

					if (rover.zling.health.driver2_consecutive_read_errors >= 4) {
						autoRecoverDriver2(`consecutive read errors (${rover.zling.health.driver2_consecutive_read_errors})`);
					}

					if (err.message.includes('CRC')) {
						console.warn("CRC error detected - check serial connection and baud rate");
					}
				}
			}
			} finally {
				rover.zling._feedbackPollInProgress = false;
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