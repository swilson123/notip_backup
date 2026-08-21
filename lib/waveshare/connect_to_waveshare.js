


var connect_to_waveshare = function (white_rabbit) {

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

	function getLastZlingCommand(white_rabbitRef, motorId) {
		if (!white_rabbitRef || !white_rabbitRef.zling || !white_rabbitRef.zling.last_cmd_rpm_by_id) {
			return 0;
		}

		return white_rabbitRef.zling.last_cmd_rpm_by_id[motorId] || 0;
	}

	function sendWaveshareFeedback(white_rabbitRef, data) {
		if (!white_rabbitRef || typeof white_rabbitRef.waveshare_message_handler !== 'function') {
			return;
		}

		try {
			white_rabbitRef.waveshare_message_handler(white_rabbitRef, data);
		} catch (handlerError) {
			console.error('waveshare_message_handler error:', handlerError.message || handlerError);
		}
	}

	if (!white_rabbit.zling.health) {
		white_rabbit.zling.health = {
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

	if (!white_rabbit.zling.health.stall_reads_by_motor_id) {
		white_rabbit.zling.health.stall_reads_by_motor_id = { 1: 0, 2: 0, 3: 0, 4: 0 };
	}

	function detectWheelStall(white_rabbitRef, motorId, measuredRpmAbs) {
		// getLastZlingCommand returns the RAW Modbus value, which for reverse
		// motion is encoded as `65536 + rpm × throttle` (two's-complement-as-
		// unsigned). Decode back to a signed RPM before taking abs, otherwise
		// any reverse command looks like "commanded ~65000 RPM" and the stall
		// check arms on every reverse tick.
		const rawCmd = getLastZlingCommand(white_rabbitRef, motorId);
		const signedCmd = rawCmd > 32768 ? rawCmd - 65536 : rawCmd;
		const expectedRpmAbs = Math.abs(signedCmd);

		// Thresholds in real RPM units (since the /10 scaling fix on feedback
		// puts measured RPM in human-readable units). Previously these were
		// 120/40 — tuned to the inflated ×10 scale that the buggy read used.
		const expectedThreshold = 12;
		const measuredThreshold = 4;

		if (expectedRpmAbs >= expectedThreshold && measuredRpmAbs <= measuredThreshold) {
			white_rabbitRef.zling.health.stall_reads_by_motor_id[motorId] += 1;
		} else {
			white_rabbitRef.zling.health.stall_reads_by_motor_id[motorId] = 0;
		}

		return {
			expectedRpmAbs,
			count: white_rabbitRef.zling.health.stall_reads_by_motor_id[motorId]
		};
	}

	function updateZlingConnectedState() {
		white_rabbit.waveshare.connected = !!(white_rabbit.zling.comName1_connected && white_rabbit.zling.comName2_connected);
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

	if (white_rabbit.motor.motor_type === "ZLAC8015D") {


		//Motor Driver 1.....................................................


		async function connect_to_motor_driver1(forceReconnect = false) {

			if (white_rabbit.zling.comName1_connecting) {
				return;
			}

			if (!white_rabbit.zling.comName1_connected || forceReconnect) {
				white_rabbit.zling.comName1_connecting = true;
				if (forceReconnect && white_rabbit.motor.motor1_client) {
					await closeMotorClient(white_rabbit.motor.motor1_client, 'Driver 1');
					white_rabbit.motor.motor1_client = null;
				}

				white_rabbit.zling.comName1_connected = false;
				updateZlingConnectedState();
				white_rabbit.motor.motor1_client = new white_rabbit.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await white_rabbit.motor.motor1_client.connectRTUBuffered(white_rabbit.zling.comName1, { baudRate: white_rabbit.zling.baudrate });
					white_rabbit.motor.motor1_client.setID(white_rabbit.zling.slave1_Id);
					white_rabbit.motor.motor1_client.setTimeout(200);



// 2. Initialization Sequence with delays
				await wait(100);
				await white_rabbit.motor.motor1_client.writeRegister(white_rabbit.zling.REG_OP_MODE, 3);      // Set Velocity Mode
				await wait(100);
					await white_rabbit.motor.motor1_client.writeRegister(white_rabbit.zling.REG_CONTROL_WORD, 0x08); // Enable Driver


					if (white_rabbit.motor.motor1_client._port._id) {
						white_rabbit.zling.comName1_connected = true;
						updateZlingConnectedState();
						console.log("Connected to ZLAC8015D Driver 1");
						console.log("Driver 1 Enabled in Velocity Mode");
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Connected to ZLAC8015D Driver 1");
					}
					else {
						white_rabbit.zling.comName1_connected = false;
						updateZlingConnectedState();
						console.log("Failed to connect to ZLAC8015D Driver 1");
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Failed to connect to ZLAC8015D Driver 1");
					}





				} catch (e) {
					white_rabbit.zling.comName1_connected = false;
					updateZlingConnectedState();
					console.error("Communication DRIVER 1 Error:", e.message);
					white_rabbit.logs.connect_to_waveshare.log(white_rabbit, JSON.stringify(e.message));
					await closeMotorClient(white_rabbit.motor.motor1_client, 'Driver 1');
					white_rabbit.motor.motor1_client = null;
				} finally {
					white_rabbit.zling.comName1_connecting = false;
				}
			}
		}

		connect_to_motor_driver1();

		//Motor Driver 2.....................................................


		async function connect_to_motor_driver2(forceReconnect = false) {
			if (white_rabbit.zling.comName2_connecting) {
				return;
			}

			if (!white_rabbit.zling.comName2_connected || forceReconnect) {
				white_rabbit.zling.comName2_connecting = true;
				if (forceReconnect && white_rabbit.motor.motor2_client) {
					await closeMotorClient(white_rabbit.motor.motor2_client, 'Driver 2');
					white_rabbit.motor.motor2_client = null;
				}

				white_rabbit.zling.comName2_connected = false;
				updateZlingConnectedState();
				white_rabbit.motor.motor2_client = new white_rabbit.ModbusRTU();
				try {
					// 1. Connect to Serial Port
					await white_rabbit.motor.motor2_client.connectRTUBuffered(white_rabbit.zling.comName2, { baudRate: white_rabbit.zling.baudrate });
					white_rabbit.motor.motor2_client.setID(white_rabbit.zling.slave2_Id);
					white_rabbit.motor.motor2_client.setTimeout(200);
					console.log("Initializing Motor 2 Client", white_rabbit.motor.motor2_client);


// 2. Initialization Sequence with delays
				await wait(100);
				await white_rabbit.motor.motor2_client.writeRegister(white_rabbit.zling.REG_OP_MODE, 3);      // Set Velocity Mode
				await wait(100);
					await white_rabbit.motor.motor2_client.writeRegister(white_rabbit.zling.REG_CONTROL_WORD, 0x08); // Enable Driver


					if (white_rabbit.motor.motor2_client._port._id) {
						white_rabbit.zling.comName2_connected = true;
						updateZlingConnectedState();

						console.log("Connected to ZLAC8015D Driver 2");
						console.log("Driver 2 Enabled in Velocity Mode");
						
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Connected to ZLAC8015D Driver 2");
					}
					else {
						white_rabbit.zling.comName2_connected = false;
						updateZlingConnectedState();
						console.log("Failed to connect to ZLAC8015D Driver 2");
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Failed to connect to ZLAC8015D Driver 2");
					}

				} catch (e) {
					white_rabbit.zling.comName2_connected = false;
					updateZlingConnectedState();
					console.error("Communication DRIVER 2 Error:", e.message);
					white_rabbit.logs.connect_to_waveshare.log(white_rabbit, JSON.stringify(e.message));
					await closeMotorClient(white_rabbit.motor.motor2_client, 'Driver 2');
					white_rabbit.motor.motor2_client = null;
				} finally {
					white_rabbit.zling.comName2_connecting = false;
				}
			}
		}

		connect_to_motor_driver2();

		async function zeroDriverTargets(client) {
			if (!client) {
				return;
			}

			await client.writeRegister(white_rabbit.zling.REG_L_TARGET_RPM, 0);
			await client.writeRegister(white_rabbit.zling.REG_R_TARGET_RPM, 0);
		}

		async function replayDriverCommands(client, leftMotorId, rightMotorId) {
			if (!client) {
				return;
			}

			await client.writeRegister(white_rabbit.zling.REG_R_TARGET_RPM, getLastZlingCommand(white_rabbit, rightMotorId));
			await client.writeRegister(white_rabbit.zling.REG_L_TARGET_RPM, getLastZlingCommand(white_rabbit, leftMotorId));
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

			const client = white_rabbit.motor[clientKey];
			if (!client) {
				return false;
			}

			try {
				await zeroDriverTargets(client);
			} catch (stopError) {
				console.warn(`${label} stop-before-reconnect warning:`, stopError.message || stopError);
			}

			try {
				await client.writeRegister(white_rabbit.zling.REG_CONTROL_WORD, 0x80);
			} catch (resetError) {
				console.warn(`${label} fault-reset command not accepted:`, resetError.message);
			}

			white_rabbit["zling"][connectionFlag] = false;
			updateZlingConnectedState();
			if (white_rabbit.motor._writeQueues && white_rabbit.motor._writeQueues[queueKey]) {
				white_rabbit.motor._writeQueues[queueKey] = Promise.resolve();
			}

			await closeMotorClient(client, label);
			white_rabbit.motor[clientKey] = null;
			await wait(250);

			await connectFn(true);
			if (!white_rabbit.zling[connectionFlag] || !white_rabbit.motor[clientKey]) {
				throw new Error(`${label} reconnect did not complete`);
			}

			await wait(150);
			await replayDriverCommands(white_rabbit.motor[clientKey], leftMotorId, rightMotorId);
			return true;
		}

		async function autoRecoverDriver1(reason) {
			if (!white_rabbit.motor.motor1_client) {
				return;
			}

			if (white_rabbit.zling.health.driver1_recovery_in_progress) {
				return;
			}

			const now = Date.now();
			const cooldownMs = 10000;
			if (now - white_rabbit.zling.health.driver1_last_recovery_ts < cooldownMs) {
				return;
			}

			white_rabbit.zling.health.driver1_recovery_in_progress = true;
			white_rabbit.zling.health.driver1_last_recovery_ts = now;
			console.warn("Driver 1 auto-recovery triggered:", reason);
			white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Driver 1 auto-recovery triggered:", reason);

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
				white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Driver 1 auto-recovery completed");
				white_rabbit.zling.health.stall_reads_by_motor_id[1] = 0;
				white_rabbit.zling.health.stall_reads_by_motor_id[3] = 0;
				white_rabbit.zling.health.driver1_consecutive_read_errors = 0;
			} catch (recoveryError) {
				console.error("Driver 1 auto-recovery failed:", recoveryError.message);
				white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Driver 1 auto-recovery failed:", recoveryError.message);
			} finally {
				white_rabbit.zling.health.driver1_recovery_in_progress = false;
			}
		}

		async function autoRecoverDriver2(reason) {
			if (!white_rabbit.motor.motor2_client) {
				return;
			}

			if (white_rabbit.zling.health.driver2_recovery_in_progress) {
				return;
			}

			const now = Date.now();
			const cooldownMs = 10000;
			if (now - white_rabbit.zling.health.driver2_last_recovery_ts < cooldownMs) {
				return;
			}

			white_rabbit.zling.health.driver2_recovery_in_progress = true;
			white_rabbit.zling.health.driver2_last_recovery_ts = now;
			console.warn("Driver 2 auto-recovery triggered:", reason);
			white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Driver 2 auto-recovery triggered:", reason);

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
				white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Driver 2 auto-recovery completed");
				white_rabbit.zling.health.stall_reads_by_motor_id[2] = 0;
				white_rabbit.zling.health.stall_reads_by_motor_id[4] = 0;
				white_rabbit.zling.health.driver2_consecutive_read_errors = 0;
			} catch (recoveryError) {
				console.error("Driver 2 auto-recovery failed:", recoveryError.message);
				white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Driver 2 auto-recovery failed:", recoveryError.message);
			} finally {
				white_rabbit.zling.health.driver2_recovery_in_progress = false;
			}
		}





		// 4. Feedback Loop (Read every 500ms)
		if (white_rabbit.zling._feedbackInterval) {
			clearInterval(white_rabbit.zling._feedbackInterval);
		}

		white_rabbit.zling._feedbackPollInProgress = false;

		white_rabbit.zling._feedbackInterval = setInterval(() => {
			if (white_rabbit.zling._feedbackPollInProgress) {
				return;
			}

			white_rabbit.zling._feedbackPollInProgress = true;

			if (!white_rabbit.motor._writeQueues) {
				white_rabbit.motor._writeQueues = {};
			}

			const p1 = white_rabbit.zling.comName1_connected
				? enqueuePromise(white_rabbit.motor._writeQueues, 'motor1', async () => {
					if (!white_rabbit.motor.motor1_client) {
						console.warn("Motor 1 client not available");
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Motor 1 client not available");
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
								white_rabbit.motor.motor1_client.readHoldingRegisters(white_rabbit.zling.REG_L_POS_HI, 6),
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
								white_rabbit.motor.motor1_client.readHoldingRegisters(white_rabbit.zling.REG_L_FEEDBACK, 2),
								350,
								'Driver 1 speed fallback read'
							);
							leftSpeed  = toSigned16(res2.data[0]) / 10;
							rightSpeed = toSigned16(res2.data[1]) / 10;
						}

						white_rabbit.zling.health.driver1_consecutive_read_errors = 0;

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
						sendWaveshareFeedback(white_rabbit, data);

						// Motor mapping on driver 1: left feedback -> id 3, right feedback -> id 1
						const frontDriver = detectWheelStall(white_rabbit, 3, Math.abs(leftSpeed));
						const frontPassenger = detectWheelStall(white_rabbit, 1, Math.abs(rightSpeed));

						if (frontDriver.count >= 6) {
							autoRecoverDriver1(`wheel id 3 stalled while commanded ${frontDriver.expectedRpmAbs} RPM (feedback ${Math.abs(leftSpeed)} RPM)`);
						}

						if (frontPassenger.count >= 6) {
							autoRecoverDriver1(`wheel id 1 stalled while commanded ${frontPassenger.expectedRpmAbs} RPM (feedback ${Math.abs(rightSpeed)} RPM)`);
						}

						//console.log(`Current Speed -> Left: ${leftSpeed} RPM | Right: ${rightSpeed} RPM`);
					} catch (err) {
						console.error("Error reading Zling Com 1:", err.message);
						white_rabbit.zling.health.driver1_consecutive_read_errors += 1;
						if (white_rabbit.zling.health.driver1_consecutive_read_errors >= 4) {
							autoRecoverDriver1(`consecutive read errors (${white_rabbit.zling.health.driver1_consecutive_read_errors})`);
						}
						if (err.message.includes('CRC')) {
							console.warn("CRC error detected - check serial connection and baud rate");
							white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "CRC error detected - check serial connection and baud rate");
						}
					}
				})
				: Promise.resolve();

			const p2 = white_rabbit.zling.comName2_connected
				? enqueuePromise(white_rabbit.motor._writeQueues, 'motor2', async () => {
					if (!white_rabbit.motor.motor2_client) {
						console.warn("Motor 2 client not available");
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Motor 2 client not available");
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
								white_rabbit.motor.motor2_client.readHoldingRegisters(white_rabbit.zling.REG_L_POS_HI, 6),
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
								white_rabbit.motor.motor2_client.readHoldingRegisters(white_rabbit.zling.REG_L_FEEDBACK, 2),
								350,
								'Driver 2 speed fallback read'
							);
							leftSpeed  = toSigned16(res2.data[0]) / 10;
							rightSpeed = toSigned16(res2.data[1]) / 10;
						}

						white_rabbit.zling.health.driver2_consecutive_read_errors = 0;

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
						sendWaveshareFeedback(white_rabbit, data);

						// Motor mapping on driver 2: left feedback -> id 4, right feedback -> id 2
						const backDriver = detectWheelStall(white_rabbit, 4, Math.abs(leftSpeed));
						const backPassenger = detectWheelStall(white_rabbit, 2, Math.abs(rightSpeed));

						if (backDriver.count >= 6) {
							autoRecoverDriver2(`wheel id 4 stalled while commanded ${backDriver.expectedRpmAbs} RPM (feedback ${Math.abs(leftSpeed)} RPM)`);
						}

						if (backPassenger.count >= 6) {
							autoRecoverDriver2(`wheel id 2 stalled while commanded ${backPassenger.expectedRpmAbs} RPM (feedback ${Math.abs(rightSpeed)} RPM)`);
						}

						//console.log(`Current Speed -> Left: ${leftSpeed} RPM | Right: ${rightSpeed} RPM`);
					} catch (err) {
						console.error("Error reading Zling Com 2:", err.message);
						white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Error reading Zling Com 2:", err.message);
						white_rabbit.zling.health.driver2_consecutive_read_errors += 1;

						if (white_rabbit.zling.health.driver2_consecutive_read_errors >= 4) {
							autoRecoverDriver2(`consecutive read errors (${white_rabbit.zling.health.driver2_consecutive_read_errors})`);
						}

						if (err.message.includes('CRC')) {
							console.warn("CRC error detected - check serial connection and baud rate");
							white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "CRC error detected - check serial connection and baud rate");
						}
					}
				})
				: Promise.resolve();

			Promise.all([p1, p2]).then(() => {
				white_rabbit.zling._feedbackPollInProgress = false;
			});
		}, 500);

		// Zling Motor Test (uncomment to run)....................................
		//white_rabbit.zling_motor_test(white_rabbit);

	}
	else if (white_rabbit.motor.motor_type === "DDSM115") {
		if (white_rabbit.waveshare.port_path && !white_rabbit.waveshare.connected) {
			white_rabbit.waveshare.serial = new white_rabbit.SerialPort({
				path: white_rabbit.waveshare.port_path,
				baudRate: white_rabbit.waveshare.baudrate,
			});

			//When port is open
			white_rabbit.waveshare.serial.on('open', function () {

				console.log("Waveshare Port is open");
				white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Waveshare Port is open");
				white_rabbit.waveshare.connected = true;


				white_rabbit.waveshare.serial.write('EN1\r\n');



				// Raw data listener to parse 10-byte DDSM frames and emit 'feedback'
				white_rabbit.waveshare.serial.on('data', function (data) {
					console.log(data);
					
				});


				white_rabbit.waveshare.parser = white_rabbit.waveshare.serial.pipe(new white_rabbit.Readline(
					{
						delimiter: '\r\n'
					}));


				white_rabbit.waveshare.parser.on('data', function (input) {

					console.log('Waveshare Data:', input);
				
					white_rabbit.waveshare_message_handler(white_rabbit, input);


				});

				white_rabbit.waveshare.parser.on('error', function (e) {
					console.log('white_rabbit.waveshare.parser: ', e);

				});


			});


			white_rabbit.waveshare.serial.on('close', function (e) {
				white_rabbit.waveshare.connected = false;
				console.log("Waveshare Port closed: ", e);
				white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Waveshare Port closed: " + e);



			});

			white_rabbit.waveshare.serial.on('error', function (e) {

				if (e) {
					console.log("Waveshare Port error: ", e);
					white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Waveshare Port error: " + e);

				}
			});

		}
		else {
			console.log('Missing waveshare port');
			white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Missing waveshare port");

		}
	}
	else {
		console.log("Unsupported motor type: ", white_rabbit.motor.motor_type);
		white_rabbit.logs.connect_to_waveshare.log(white_rabbit, "Unsupported motor type: " + white_rabbit.motor.motor_type);
	}

	// Zling Motor Test (uncomment to run)....................................
	//white_rabbit.ddsm_motor_test(white_rabbit);

};


module.exports = connect_to_waveshare;