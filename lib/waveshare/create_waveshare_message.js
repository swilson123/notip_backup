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

function enqueueDDSMWrite(white_rabbit, line) {
	if (!white_rabbit.waveshare._writeQueue) {
		white_rabbit.waveshare._writeQueue = [];
	}

	white_rabbit.waveshare._writeQueue.push(line);

	if (white_rabbit.waveshare._isWritingQueue) {
		return;
	}

	white_rabbit.waveshare._isWritingQueue = true;

	const flushNext = function () {
		if (!white_rabbit.waveshare._writeQueue.length) {
			white_rabbit.waveshare._isWritingQueue = false;
			return;
		}

		const nextLine = white_rabbit.waveshare._writeQueue.shift();
		white_rabbit.waveshare.serial.write(nextLine, (writeErr) => {
			if (writeErr) {
				console.error('Failed to write DDSM command:', writeErr.message || writeErr);
				setImmediate(flushNext);
				return;
			}

			white_rabbit.waveshare.serial.drain((drainErr) => {
				if (drainErr) {
					console.error('Failed to drain DDSM serial buffer:', drainErr.message || drainErr);
				}
				setImmediate(flushNext);
			});
		});
	};

	setImmediate(flushNext);
}

function trackZlingCommand(white_rabbit, message) {
	if (!white_rabbit || !white_rabbit.zling || !message || typeof message.id === 'undefined') {
		return;
	}

	if (!white_rabbit.zling.last_cmd_rpm_by_id) {
		white_rabbit.zling.last_cmd_rpm_by_id = {};
	}

	white_rabbit.zling.last_cmd_rpm_by_id[message.id] = message.cmd;
	white_rabbit.zling.last_cmd_rpm_by_id.last_updated_ts = Date.now();
}

var create_waveshare_message = function (white_rabbit, message) {
	if (white_rabbit.waveshare.connected) {
		if (message) {
			//console.log('Sending waveshare Message: ', message);

			if (white_rabbit.motor.motor_type === "ZLAC8015D") {
				trackZlingCommand(white_rabbit, message);

				if (!white_rabbit.motor._writeQueues) {
					white_rabbit.motor._writeQueues = {};
				}

				if (message.id == 1) {
					if (!white_rabbit.motor.motor1_client) {
						console.error('Motor 1 client not initialized');
						return;
					}
					enqueuePromise(white_rabbit.motor._writeQueues, 'motor1', () =>
						writeRegisterWithRetry(white_rabbit.motor.motor1_client, white_rabbit.zling.REG_R_TARGET_RPM, message.cmd)
					);
				}
				else if (message.id == 2) {
					if (!white_rabbit.motor.motor2_client) {
						console.error('Motor 2 client not initialized');
						return;
					}
					enqueuePromise(white_rabbit.motor._writeQueues, 'motor2', () =>
						writeRegisterWithRetry(white_rabbit.motor.motor2_client, white_rabbit.zling.REG_R_TARGET_RPM, message.cmd)
					);
					
				}
				else if (message.id == 3) {
					if (!white_rabbit.motor.motor1_client) {
						console.error('Motor 1 client not initialized');
						return;
					}
					enqueuePromise(white_rabbit.motor._writeQueues, 'motor1', () =>
						writeRegisterWithRetry(white_rabbit.motor.motor1_client, white_rabbit.zling.REG_L_TARGET_RPM, message.cmd)
					);
				
				}
				else if (message.id == 4) {
					if (!white_rabbit.motor.motor2_client) {
						console.error('Motor 2 client not initialized');
						return;
					}
					enqueuePromise(white_rabbit.motor._writeQueues, 'motor2', () =>
						writeRegisterWithRetry(white_rabbit.motor.motor2_client, white_rabbit.zling.REG_L_TARGET_RPM, message.cmd)
					);
					
				}
				else {
					console.log('Unsupported motor id: ', message.id);
				}
			} else if (white_rabbit.motor.motor_type === "DDSM115") {
				var jsonLine = JSON.stringify(message) + '\n';
				enqueueDDSMWrite(white_rabbit, jsonLine);
			} else {
				console.log("Unsupported motor type: ", white_rabbit.motor.motor_type);
			}




		} else {
			console.log('Missing waveshare message');
		}
	} else {
		console.log('Waveshare not connected!');
	}
};

module.exports = create_waveshare_message;
