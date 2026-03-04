var servo_send_command = function (rover, servo_id, pwm_value) {

    if (servo_id) {
        var servo_found = false;

        for (let i = 0; i < rover.servos; i++) {
            if (rover.servos[i].servo_id == servo_id) {
                rover.servos[i].commanded_pwm = pwm_value;
                servo_found = rover.servos[i];
            }
        }


        if (servo_found) {
            const target_pwm = Number(servo_found.commanded_pwm);
            let current_pwm = Number(servo_found.set_pwm);

            if (!Number.isFinite(current_pwm)) {
                current_pwm = target_pwm;
            }

            const step = target_pwm >= current_pwm ? 50 : -50;
            const max_steps = Math.ceil(Math.abs(target_pwm - current_pwm) / 50) + 1;

            for (let i = 0; i < max_steps; i++) {
                if (current_pwm !== target_pwm) {
                    current_pwm += step;

                    if ((step > 0 && current_pwm > target_pwm) || (step < 0 && current_pwm < target_pwm)) {
                        current_pwm = target_pwm;
                    }
                }

                servo_found.set_pwm = current_pwm;

                const data = {
                    param1: servo_id,         // Servo number (e.g., 10 = SERVO10)
                    param2: current_pwm, // 1000 = unlocked, 2000 = locked
                    param3: 0,
                    param4: 0,
                    param5: 0,
                    param6: 0,
                    param7: 0
                };

                // Build MAVLink message
                const mav_response = rover.mavlink_messages.MAV_CMD_DO_SET_SERVO(rover, data);
                // console.log("Sending servo command:", mav_response);
                // Send to Pixhawk
                rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);

                if (current_pwm === target_pwm) {
                    break;
                }
            }

        }
        else {
            console.log("Servo ID " + servo_id + " not found in rover.servos");
        }

    }
    else {
        console.log("servo_id is required to send a servo command.");
    }

};


module.exports = servo_send_command;