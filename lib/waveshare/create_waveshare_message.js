// Helper function for retry logic with exponential backoff
async function writeRegisterWithRetry(client, register, value, maxRetries = 3, initialDelay = 100) {
	for (let i = 0; i < maxRetries; i++) {
		try {
			const delay = initialDelay * Math.pow(2, i);
			if (i > 0) {
				await new Promise(r => setTimeout(r, delay));
			}
			await client.writeRegister(register, value);
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

var create_waveshare_message = function (rover, message) {
	if (rover.waveshare.connected) {
		if (message) {
			//console.log('Sending waveshare Message: ', message);

			if (rover.motor.motor_type === "ZLAC8015D") {

				if (message.id == 1) {
					if (!rover.motor.motor1_client) {
						console.error('Motor 1 client not initialized');
						return;
					}
					writeRegisterWithRetry(rover.motor.motor1_client, rover.zling.REG_R_TARGET_RPM, message.cmd).catch(err => {
						console.error('Failed to send motor 1 command:', err);
					});
				}
				else if (message.id == 2) {
					if (!rover.motor.motor2_client) {
						console.error('Motor 2 client not initialized');
						return;
					}
					writeRegisterWithRetry(rover.motor.motor2_client, rover.zling.REG_R_TARGET_RPM, message.cmd).catch(err => {
						console.error('Failed to send motor 2 command:', err);
					});
					
				}
				else if (message.id == 3) {
					if (!rover.motor.motor1_client) {
						console.error('Motor 1 client not initialized');
						return;
					}
					writeRegisterWithRetry(rover.motor.motor1_client, rover.zling.REG_L_TARGET_RPM, message.cmd).catch(err => {
						console.error('Failed to send motor 1 command:', err);
					});
				
				}
				else if (message.id == 4) {
					if (!rover.motor.motor2_client) {
						console.error('Motor 2 client not initialized');
						return;
					}
					writeRegisterWithRetry(rover.motor.motor2_client, rover.zling.REG_L_TARGET_RPM, message.cmd).catch(err => {
						console.error('Failed to send motor 2 command:', err);
					});
					
				}
				else {
					console.log('Unsupported motor id: ', message.id);
				}
			} else if (rover.motor.motor_type === "DDSM115") {
				var jsonLine = JSON.stringify(message) + '\n';
				rover.waveshare.serial.write(jsonLine);
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
