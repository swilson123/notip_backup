var servo_send_command = async function (white_rabbit, servo_id, pwm_value, step_delay_on) {

    if (servo_id) {


        var servo_found = false;

        for (const servo of Object.values(white_rabbit.servos)) {
            if (servo.servo_id == servo_id) {
                servo.commanded_pwm = pwm_value;
                servo_found = servo;
                break;
            }
        }


        if (servo_found) {

            if (step_delay_on) {

                const target_pwm = Number(servo_found.commanded_pwm);
                let current_pwm = Number(servo_found.set_pwm);

                if (!Number.isFinite(current_pwm)) {
                    current_pwm = target_pwm;
                }

                const step = target_pwm >= current_pwm ? 25 : -25;
                const max_steps = Math.ceil(Math.abs(target_pwm - current_pwm) / Math.abs(step));

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
                    const mav_response = white_rabbit.mavlink_messages.MAV_CMD_DO_SET_SERVO(white_rabbit, data);
                    // console.log("Sending servo command:", mav_response);
                    // Send to Pixhawk
                    white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], null);

                    // Wait 250ms before next command
                    await new Promise(resolve => setTimeout(resolve, 100));

                    if (current_pwm === target_pwm) {
                        break;
                    }
                }

            } else {

                servo_found.set_pwm = servo_found.commanded_pwm;
                const data = {
                    param1: servo_id,         // Servo number (e.g., 10 = SERVO10)
                    param2: servo_found.commanded_pwm, // 1000 = unlocked, 2000 = locked
                    param3: 0,
                    param4: 0,
                    param5: 0,
                    param6: 0,
                    param7: 0
                };

                // Build MAVLink message
                const mav_response = white_rabbit.mavlink_messages.MAV_CMD_DO_SET_SERVO(white_rabbit, data);
                // console.log("Sending servo command:", mav_response);
                // Send to Pixhawk
                white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], null);
            }
        }
        else {
            console.log("Servo ID " + servo_id + " not found in white_rabbit.servos");
        }




    }
    else {
        console.log("servo_id is required to send a servo command.");
    }

};


module.exports = servo_send_command;