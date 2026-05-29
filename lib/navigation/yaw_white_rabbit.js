// Per-tick 4-wheel spin command. The function applies a *one-shot* motor
// command based on the sign of `signed_error_deg`; the magnitude is unused
// because the closed loop lives in the caller (the 250 ms mission tick
// recomputes the remaining error and calls this again).
//
// Sign convention (matches CLAUDE.md): positive = clockwise (right turn),
// negative = counterclockwise (left), zero = stop. Callers must pass a
// signed error, not an absolute angle.
var yaw_white_rabbit = function (white_rabbit, signed_error_deg, motor_speed_cmd) {
	console.log("Yawing white_rabbit, signed error:", signed_error_deg);

	white_rabbit.motor.last_motor_speed_cmd = 0;

	if (motor_speed_cmd > 50) motor_speed_cmd = 50;

	const dir = signed_error_deg > 0 ? 1 : (signed_error_deg < 0 ? -1 : 0);

	white_rabbit.servo_send_command(white_rabbit, 11, 1750, true);
	white_rabbit.servo_send_command(white_rabbit, 12, 1750, true);
	white_rabbit.servo_send_command(white_rabbit, 13, 1750, true);
	white_rabbit.servo_send_command(white_rabbit, 14, 1750, true);

	// Wait until all four steering servos have actually reached spin-in-place
	// geometry before commanding motors — otherwise we apply yaw force while
	// wheels are still angled for driving and stress the drivetrain.
	const servos_in_position =
		white_rabbit.servos.motor_front_driver.set_pwm    > 1700 && white_rabbit.servos.motor_front_driver.set_pwm    < 1800 &&
		white_rabbit.servos.motor_back_driver.set_pwm     > 1700 && white_rabbit.servos.motor_back_driver.set_pwm     < 1800 &&
		white_rabbit.servos.motor_front_passenger.set_pwm > 1700 && white_rabbit.servos.motor_front_passenger.set_pwm < 1800 &&
		white_rabbit.servos.motor_back_passenger.set_pwm  > 1700 && white_rabbit.servos.motor_back_passenger.set_pwm  < 1800;

	if (servos_in_position && dir !== 0) {
		white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * dir, "yaw_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * dir, "yaw_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd * dir, "yaw_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * dir, "yaw_white_rabbit");
	} else {
		white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "yaw_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "yaw_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "yaw_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "yaw_white_rabbit");
	}
};


module.exports = yaw_white_rabbit;
