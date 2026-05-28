


var connect_to_waveshare = function (rover) {

	function withTimeout(promise, timeoutMs, label) {
		return Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
		]);
	}

	function enqueuePromise(queueStore, queueKey, workFn) {
		if (!queueStore[queueKey]) {
			queueStore[queueKey] = Promise.resolve();
		}
		queueStore[queueKey] = queueStore[queueKey]
			.then(() => workFn())
			.catch((error) => {
				console.error(`Queue ${queueKey} command failed:`, error.message || error);
			});
		return queueStore[queueKey];
	}

	function toSigned16(value) {
		const normalized = value & 0xFFFF;
		return normalized > 0x7FFF ? normalized - 0x10000 : normalized;
	}

	// Assemble a 32-bit signed integer from HI and LO 16-bit Modbus registers.
	// ZLAC8015D encoder position is signed int32 across two consecutive
	// registers (HI then LO).
	function toSigned32(hi, lo) {
		const u32 = ((hi & 0xFFFF) * 0x10000) + (lo & 0xFFFF);
		return u32 > 0x7FFFFFFF ? u32 - 0x100000000 : u32;
	}

	function wait(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function getLastZlingCommand(roverRef, motorId) {
		if (!roverRef || !roverRef.zling || !roverRef.zling.last_cmd_rpm_by_id) {
			return 0;
		}

		return roverRef.zling.last_cmd_rpm_by_id[motorId] || 0;
	}

	function sendWaveshareFeedback(roverRef, data) {
		if (!roverRef || typeof roverRef.waveshare_message_handler !== 'function') {
			return;
		}

		try {
			roverRef.waveshare_message_handler(roverRef, data);
		} catch (handlerError) {
			console.error('waveshare_message_handler error:', handlerError.message || handlerError);
		}
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
		// getLastZlingCommand returns the RAW Modbus value, which for reverse
		// motion is encoded as `65536 + rpm × throttle` (two's-complement-as-
		// unsigned). Decode back to a signed RPM before taking abs, otherwise
		// any reverse command looks like "commanded ~65000 RPM" and the stall
		// check arms on every reverse tick.
		const rawCmd = getLastZlingCommand(roverRef, motorId);
		const signedCmd = rawCmd > 32768 ? rawCmd - 65536 : rawCmd;
		const expectedRpmAbs = Math.abs(signedCmd);

		// Thresholds in real RPM units (since the /10 scaling fix on feedback
		// puts measured RPM in human-readable units). Previously these were
		// 120/40 — tuned to the inflated ×10 scale that the buggy read used.
		const expectedThreshold = 12;
		const measuredThreshold = 4;

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

	function updateZlingConnectedState() {
		rover.waveshare.connected = !!(rover.zling.comName1_connected && rover.zling.comName2_connected);
	}

	async function closeMotorClient(client, label) {
		if (!client || typeof client.close !== 'function') {
			return;
		}

		await new Promise((resolve) => {
			let finished = false;
			const finish = () => {
				if (!finished) {
					finished = true;
					resolve();
				}
			};

			try {
				client.close(() => finish());
				setTimeout(finish, 500);
			} catch (closeError) {
				console.warn(`${label} close warning:`, closeError.message || closeError);
				finish();
			}
		});
	}

	if (rover.motor.motor_type === "ZLAC8015D") {


		//Motor Driver 1.....................................................


		async function connect_to_motor_driver1(forceReconnect = false) {

			if (!rover.zling.comName1_connected || forceReconnect) {
				if (forceReconnect && rover.motor.motor1_client) {
					await closeMotorClient(rover.motor.motor1_client, 'Driver 1');
					rover.motor.motor1_client = null;
				}

				rover.zling.comName1_connected = false;
				updateZlingConnectedState();
				rover.motor.motor1_client = new rover.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await rover.motor.motor1_client.connectRTUBuffered(rover.zling.comName1, { baudRate: rover.zling.baudrate });
					rover.motor.motor1_client.setID(rover.zling.slave1_Id);
					rover.motor.motor1_client.setTimeout(200);



// 2. Initialization Sequence with delays
				await wait(100);
				await rover.motor.motor1_client.writeRegister(rover.zling.REG_OP_MODE, 3);      // Set Velocity Mode
				await wait(100);
					await rover.motor.motor1_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x08); // Enable Driver


					if (rover.motor.motor1_client._port._id) {
						rover.zling.comName1_connected = true;
						updateZlingConnectedState();
						console.log("Connected to ZLAC8015D Driver 1");
						console.log("Driver 1 Enabled in Velocity Mode");
						rover.logs.connect_to_waveshare.log(rover, "Connected to ZLAC8015D Driver 1");
					}
					else {
						rover.zling.comName1_connected = false;
						updateZlingConnectedState();
						console.log("Failed to connect to ZLAC8015D Driver 1");
						rover.logs.connect_to_waveshare.log(rover, "Failed to connect to ZLAC8015D Driver 1");
					}





				} catch (e) {
					rover.zling.comName1_connected = false;
					updateZlingConnectedState();
					console.error("Communication DRIVER 1 Error:", e.message);
					rover.logs.connect_to_waveshare.log(rover, JSON.stringify(e.message));
				}
			}
		}

		connect_to_motor_driver1();

		//Motor Driver 2.....................................................


		async function connect_to_motor_driver2(forceReconnect = false) {
			if (!rover.zling.comName2_connected || forceReconnect) {
				if (forceReconnect && rover.motor.motor2_client) {
					await closeMotorClient(rover.motor.motor2_client, 'Driver 2');
					rover.motor.motor2_client = null;
				}

				rover.zling.comName2_connected = false;
				updateZlingConnectedState();
				rover.motor.motor2_client = new rover.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await rover.motor.motor2_client.connectRTUBuffered(rover.zling.comName2, { baudRate: rover.zling.baudrate });
					rover.motor.motor2_client.setID(rover.zling.slave2_Id);
					rover.motor.motor2_client.setTimeout(200);
					console.log("Initializing Motor 2 Client", rover.motor.motor2_client);


// 2. Initialization Sequence with delays
				await wait(100);
				await rover.motor.motor2_client.writeRegister(rover.zling.REG_OP_MODE, 3);      // Set Velocity Mode
				await wait(100);
					await rover.motor.motor2_client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x08); // Enable Driver


					if (rover.motor.motor2_client._port._id) {
						rover.zling.comName2_connected = true;
						updateZlingConnectedState();

						console.log("Connected to ZLAC8015D Driver 2");
						console.log("Driver 2 Enabled in Velocity Mode");
						
						rover.logs.connect_to_waveshare.log(rover, "Connected to ZLAC8015D Driver 2");
					}
					else {
						rover.zling.comName2_connected = false;
						updateZlingConnectedState();
						console.log("Failed to connect to ZLAC8015D Driver 2");
						rover.logs.connect_to_waveshare.log(rover, "Failed to connect to ZLAC8015D Driver 2");
					}

				} catch (e) {
					rover.zling.comName2_connected = false;
					updateZlingConnectedState();
					console.error("Communication DRIVER 2 Error:", e.message);
					rover.logs.connect_to_waveshare.log(rover, JSON.stringify(e.message));
				}
			}
		}

		connect_to_motor_driver2();

		async function zeroDriverTargets(client) {
			if (!client) {
				return;
			}

			await client.writeRegister(rover.zling.REG_L_TARGET_RPM, 0);
			await client.writeRegister(rover.zling.REG_R_TARGET_RPM, 0);
		}

		async function replayDriverCommands(client, leftMotorId, rightMotorId) {
			if (!client) {
				return;
			}

			await client.writeRegister(rover.zling.REG_R_TARGET_RPM, getLastZlingCommand(rover, rightMotorId));
			await client.writeRegister(rover.zling.REG_L_TARGET_RPM, getLastZlingCommand(rover, leftMotorId));
		}

		async function softRecoverDriver(config) {
			const {
				label,
				clientKey,
				connectionFlag,
				queueKey,
				connectFn,
				leftMotorId,
				rightMotorId
			} = config;

			const client = rover.motor[clientKey];
			if (!client) {
				return false;
			}

			try {
				await zeroDriverTargets(client);
			} catch (stopError) {
				console.warn(`${label} stop-before-reconnect warning:`, stopError.message || stopError);
			}

			try {
				await client.writeRegister(rover.zling.REG_CONTROL_WORD, 0x80);
			} catch (resetError) {
				console.warn(`${label} fault-reset command not accepted:`, resetError.message);
			}

			rover["zling"][connectionFlag] = false;
			updateZlingConnectedState();
			if (rover.motor._writeQueues && rover.motor._writeQueues[queueKey]) {
				rover.motor._writeQueues[queueKey] = Promise.resolve();
			}

			await closeMotorClient(client, label);
			rover.motor[clientKey] = null;
			await wait(250);

			await connectFn(true);
			if (!rover.zling[connectionFlag] || !rover.motor[clientKey]) {
				throw new Error(`${label} reconnect did not complete`);
			}

			await wait(150);
			await replayDriverCommands(rover.motor[clientKey], leftMotorId, rightMotorId);
			return true;
		}

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
			rover.logs.connect_to_waveshare.log(rover, "Driver 1 auto-recovery triggered:", reason);

			try {
				await softRecoverDriver({
					label: 'Driver 1',
					clientKey: 'motor1_client',
					connectionFlag: 'comName1_connected',
					queueKey: 'motor1',
					connectFn: connect_to_motor_driver1,
					leftMotorId: 3,
					rightMotorId: 1
				});

				console.log("Driver 1 auto-recovery completed");
				rover.logs.connect_to_waveshare.log(rover, "Driver 1 auto-recovery completed");
				rover.zling.health.stall_reads_by_motor_id[1] = 0;
				rover.zling.health.stall_reads_by_motor_id[3] = 0;
				rover.zling.health.driver1_consecutive_read_errors = 0;
			} catch (recoveryError) {
				console.error("Driver 1 auto-recovery failed:", recoveryError.message);
				rover.logs.connect_to_waveshare.log(rover, "Driver 1 auto-recovery failed:", recoveryError.message);
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
			rover.logs.connect_to_waveshare.log(rover, "Driver 2 auto-recovery triggered:", reason);

			try {
				await softRecoverDriver({
					label: 'Driver 2',
					clientKey: 'motor2_client',
					connectionFlag: 'comName2_connected',
					queueKey: 'motor2',
					connectFn: connect_to_motor_driver2,
					leftMotorId: 4,
					rightMotorId: 2
				});

				console.log("Driver 2 auto-recovery completed");
				rover.logs.connect_to_waveshare.log(rover, "Driver 2 auto-recovery completed");
				rover.zling.health.stall_reads_by_motor_id[2] = 0;
				rover.zling.health.stall_reads_by_motor_id[4] = 0;
				rover.zling.health.driver2_consecutive_read_errors = 0;
			} catch (recoveryError) {
				console.error("Driver 2 auto-recovery failed:", recoveryError.message);
				rover.logs.connect_to_waveshare.log(rover, "Driver 2 auto-recovery failed:", recoveryError.message);
			} finally {
				rover.zling.health.driver2_recovery_in_progress = false;
			}
		}





		// 4. Feedback Loop (Read every 500ms)
		if (rover.zling._feedbackInterval) {
			clearInterval(rover.zling._feedbackInterval);
		}

		rover.zling._feedbackPollInProgress = false;

		rover.zling._feedbackInterval = setInterval(() => {
			if (rover.zling._feedbackPollInProgress) {
				return;
			}

			rover.zling._feedbackPollInProgress = true;

			if (!rover.motor._writeQueues) {
				rover.motor._writeQueues = {};
			}

			const p1 = rover.zling.comName1_connected
				? enqueuePromise(rover.motor._writeQueues, 'motor1', async () => {
					if (!rover.motor.motor1_client) {
						console.warn("Motor 1 client not available");
						rover.logs.connect_to_waveshare.log(rover, "Motor 1 client not available");
						return;
					}
					try {
						// Attempt 6-register read: REG_L_POS_HI (0x20A7) through
						// REG_R_FEEDBACK (0x20AC) for position + speed in one shot.
						// Falls back to the 2-register speed-only read if this fails
						// so that a firmware that doesn't expose position registers
						// doesn't trigger autoRecoverDriver via consecutive read errors.
						let leftPos    = null;
						let rightPos   = null;
						let leftSpeed;
						let rightSpeed;

						try {
							const res = await withTimeout(
								rover.motor.motor1_client.readHoldingRegisters(rover.zling.REG_L_POS_HI, 6),
								350,
								'Driver 1 feedback read'
							);
							leftPos    = toSigned32(res.data[0], res.data[1]);
							rightPos   = toSigned32(res.data[2], res.data[3]);
							// ZLAC8015D RPM registers store RPM × 10 (0.1 RPM resolution).
							leftSpeed  = toSigned16(res.data[4]) / 10;
							rightSpeed = toSigned16(res.data[5]) / 10;
						} catch (posErr) {
							// Position read failed — fall back to speed-only read.
							// This is normal on firmware that doesn't expose REG_*_POS.
							console.warn("Driver 1 position+speed read failed, falling back to speed-only:", posErr.message);
							const res2 = await withTimeout(
								rover.motor.motor1_client.readHoldingRegisters(rover.zling.REG_L_FEEDBACK, 2),
								350,
								'Driver 1 speed fallback read'
							);
							leftSpeed  = toSigned16(res2.data[0]) / 10;
							rightSpeed = toSigned16(res2.data[1]) / 10;
						}

						rover.zling.health.driver1_consecutive_read_errors = 0;

						const data = {
							source: 'zling',
							driver: 1,
							timestamp: Date.now(),
							left_feedback_rpm: leftSpeed,
							right_feedback_rpm: rightSpeed,
							left_motor_id: 3,
							right_motor_id: 1
						};
						if (leftPos !== null)  data.left_position_pulses  = leftPos;
						if (rightPos !== null) data.right_position_pulses = rightPos;
						sendWaveshareFeedback(rover, data);

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
							rover.logs.connect_to_waveshare.log(rover, "CRC error detected - check serial connection and baud rate");
						}
					}
				})
				: Promise.resolve();

			const p2 = rover.zling.comName2_connected
				? enqueuePromise(rover.motor._writeQueues, 'motor2', async () => {
					if (!rover.motor.motor2_client) {
						console.warn("Motor 2 client not available");
						rover.logs.connect_to_waveshare.log(rover, "Motor 2 client not available");
						return;
					}
					try {
						// Same fallback strategy as driver 1: attempt 6-register read
						// for position + speed; fall back to 2-register speed-only read
						// if position registers are unavailable on this firmware.
						let leftPos    = null;
						let rightPos   = null;
						let leftSpeed;
						let rightSpeed;

						try {
							const res = await withTimeout(
								rover.motor.motor2_client.readHoldingRegisters(rover.zling.REG_L_POS_HI, 6),
								350,
								'Driver 2 feedback read'
							);
							leftPos    = toSigned32(res.data[0], res.data[1]);
							rightPos   = toSigned32(res.data[2], res.data[3]);
							leftSpeed  = toSigned16(res.data[4]) / 10;
							rightSpeed = toSigned16(res.data[5]) / 10;
						} catch (posErr) {
							console.warn("Driver 2 position+speed read failed, falling back to speed-only:", posErr.message);
							const res2 = await withTimeout(
								rover.motor.motor2_client.readHoldingRegisters(rover.zling.REG_L_FEEDBACK, 2),
								350,
								'Driver 2 speed fallback read'
							);
							leftSpeed  = toSigned16(res2.data[0]) / 10;
							rightSpeed = toSigned16(res2.data[1]) / 10;
						}

						rover.zling.health.driver2_consecutive_read_errors = 0;

						const data = {
							source: 'zling',
							driver: 2,
							timestamp: Date.now(),
							left_feedback_rpm: leftSpeed,
							right_feedback_rpm: rightSpeed,
							left_motor_id: 4,
							right_motor_id: 2
						};
						if (leftPos !== null)  data.left_position_pulses  = leftPos;
						if (rightPos !== null) data.right_position_pulses = rightPos;
						sendWaveshareFeedback(rover, data);

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
						rover.logs.connect_to_waveshare.log(rover, "Error reading Zling Com 2:", err.message);
						rover.zling.health.driver2_consecutive_read_errors += 1;

						if (rover.zling.health.driver2_consecutive_read_errors >= 4) {
							autoRecoverDriver2(`consecutive read errors (${rover.zling.health.driver2_consecutive_read_errors})`);
						}

						if (err.message.includes('CRC')) {
							console.warn("CRC error detected - check serial connection and baud rate");
							rover.logs.connect_to_waveshare.log(rover, "CRC error detected - check serial connection and baud rate");
						}
					}
				})
				: Promise.resolve();

			Promise.all([p1, p2]).then(() => {
				rover.zling._feedbackPollInProgress = false;
			});
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
				rover.logs.connect_to_waveshare.log(rover, "Waveshare Port is open");
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
				
					rover.waveshare_message_handler(rover, input);


				});

				rover.waveshare.parser.on('error', function (e) {
					console.log('rover.waveshare.parser: ', e);

				});


			});


			rover.waveshare.serial.on('close', function (e) {
				rover.waveshare.connected = false;
				console.log("Waveshare Port closed: ", e);
				rover.logs.connect_to_waveshare.log(rover, "Waveshare Port closed: " + e);



			});

			rover.waveshare.serial.on('error', function (e) {

				if (e) {
					console.log("Waveshare Port error: ", e);
					rover.logs.connect_to_waveshare.log(rover, "Waveshare Port error: " + e);

				}
			});

		}
		else {
			console.log('Missing waveshare port');
			rover.logs.connect_to_waveshare.log(rover, "Missing waveshare port");

		}
	}
	else {
		console.log("Unsupported motor type: ", rover.motor.motor_type);
		rover.logs.connect_to_waveshare.log(rover, "Unsupported motor type: " + rover.motor.motor_type);
	}

	// Zling Motor Test (uncomment to run)....................................
	//rover.ddsm_motor_test(rover);

};


module.exports = connect_to_waveshare;