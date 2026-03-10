// Helper function for retry logic with exponential backoff
function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
	]);
}

async function writeRegisterWithRetry(client, register, value, maxRetries = 3, initialDelay = 100) {
	for (let i = 0; i < maxRetries; i++) {
		try {
			const delay = initialDelay * Math.pow(2, i);
			if (i > 0) {
				await new Promise(r => setTimeout(r, delay));
			}
			await withTimeout(
				client.writeRegister(register, value),
				350,
				`writeRegister(${register})`
			);
			return true;
		} catch (error) {
			if (i === maxRetries - 1) {
				console.error(`writeRegister failed after ${maxRetries} attempts:`, error.message);
				return false;
			}
			console.warn(`writeRegister attempt ${i + 1} failed, retrying...`, error.message);
		}
	}
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

function enqueueDDSMWrite(rover, line) {
	if (!rover.waveshare._writeQueue) {
		rover.waveshare._writeQueue = [];
	}

	rover.waveshare._writeQueue.push(line);

	if (rover.waveshare._isWritingQueue) {
		return;
	}

	rover.waveshare._isWritingQueue = true;

	const flushNext = function () {
		if (!rover.waveshare._writeQueue.length) {
			rover.waveshare._isWritingQueue = false;
			return;
		}

		const nextLine = rover.waveshare._writeQueue.shift();
		rover.waveshare.serial.write(nextLine, (writeErr) => {
			if (writeErr) {
				console.error('Failed to write DDSM command:', writeErr.message || writeErr);
				setImmediate(flushNext);
				return;
			}

			rover.waveshare.serial.drain((drainErr) => {
				if (drainErr) {
					console.error('Failed to drain DDSM serial buffer:', drainErr.message || drainErr);
				}
				setImmediate(flushNext);
			});
		});
	};

	setImmediate(flushNext);
}

function trackZlingCommand(rover, message) {
	if (!rover || !rover.zling || !message || typeof message.id === 'undefined') {
		return;
	}

	if (!rover.zling.last_cmd_rpm_by_id) {
		rover.zling.last_cmd_rpm_by_id = {};
	}

	rover.zling.last_cmd_rpm_by_id[message.id] = message.cmd;
	rover.zling.last_cmd_rpm_by_id.last_updated_ts = Date.now();
}

var create_waveshare_message = function (rover, message) {
	if (rover.waveshare.connected) {
		if (message) {
			//console.log('Sending waveshare Message: ', message);

			if (rover.motor.motor_type === "ZLAC8015D") {
				trackZlingCommand(rover, message);

				if (!rover.motor._writeQueues) {
					rover.motor._writeQueues = {};
				}

				if (message.id == 1) {
					if (!rover.motor.motor1_client) {
						console.error('Motor 1 client not initialized');
						return;
					}
					enqueuePromise(rover.motor._writeQueues, 'motor1', () =>
						writeRegisterWithRetry(rover.motor.motor1_client, rover.zling.REG_R_TARGET_RPM, message.cmd)
					);
				}
				else if (message.id == 2) {
					if (!rover.motor.motor2_client) {
						console.error('Motor 2 client not initialized');
						return;
					}
					enqueuePromise(rover.motor._writeQueues, 'motor2', () =>
						writeRegisterWithRetry(rover.motor.motor2_client, rover.zling.REG_R_TARGET_RPM, message.cmd)
					);
					
				}
				else if (message.id == 3) {
					if (!rover.motor.motor1_client) {
						console.error('Motor 1 client not initialized');
						return;
					}
					enqueuePromise(rover.motor._writeQueues, 'motor1', () =>
						writeRegisterWithRetry(rover.motor.motor1_client, rover.zling.REG_L_TARGET_RPM, message.cmd)
					);
				
				}
				else if (message.id == 4) {
					if (!rover.motor.motor2_client) {
						console.error('Motor 2 client not initialized');
						return;
					}
					enqueuePromise(rover.motor._writeQueues, 'motor2', () =>
						writeRegisterWithRetry(rover.motor.motor2_client, rover.zling.REG_L_TARGET_RPM, message.cmd)
					);
					
				}
				else {
					console.log('Unsupported motor id: ', message.id);
				}
			} else if (rover.motor.motor_type === "DDSM115") {
				var jsonLine = JSON.stringify(message) + '\n';
				enqueueDDSMWrite(rover, jsonLine);
			} else {
				console.log("Unsupported motor type: ", rover.motor.motor_type);
			}




		} else {
			console.log('Missing waveshare message');
		}
	} else {
		console.log('Waveshare not connected!');
	}
};

module.exports = create_waveshare_message;
