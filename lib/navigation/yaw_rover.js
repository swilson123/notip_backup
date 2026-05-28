// Per-tick 4-wheel spin command. The function applies a *one-shot* motor
// command based on the sign of `signed_error_deg`; the magnitude is unused
// because the closed loop lives in the caller (the 250 ms mission tick
// recomputes the remaining error and calls this again).
//
// Sign convention (matches CLAUDE.md): positive = clockwise (right turn),
// negative = counterclockwise (left), zero = stop. Callers must pass a
// signed error, not an absolute angle.
var yaw_rover = function (rover, signed_error_deg, motor_speed_cmd) {
	console.log("Yawing rover, signed error:", signed_error_deg);

	rover.motor.last_motor_speed_cmd = 0;

	if (motor_speed_cmd > 50) motor_speed_cmd = 50;

	const dir = signed_error_deg > 0 ? 1 : (signed_error_deg < 0 ? -1 : 0);

	rover.servo_send_command(rover, 11, 1750, true);
	rover.servo_send_command(rover, 12, 1750, true);
	rover.servo_send_command(rover, 13, 1750, true);
	rover.servo_send_command(rover, 14, 1750, true);

	// Wait until all four steering servos have actually reached spin-in-place
	// geometry before commanding motors — otherwise we apply yaw force while
	// wheels are still angled for driving and stress the drivetrain.
	const servos_in_position =
		rover.servos.motor_front_driver.set_pwm    > 1700 && rover.servos.motor_front_driver.set_pwm    < 1800 &&
		rover.servos.motor_back_driver.set_pwm     > 1700 && rover.servos.motor_back_driver.set_pwm     < 1800 &&
		rover.servos.motor_front_passenger.set_pwm > 1700 && rover.servos.motor_front_passenger.set_pwm < 1800 &&
		rover.servos.motor_back_passenger.set_pwm  > 1700 && rover.servos.motor_back_passenger.set_pwm  < 1800;

	if (servos_in_position && dir !== 0) {
		rover.move_rover(rover, 1, motor_speed_cmd * dir, "yaw_rover");
		rover.move_rover(rover, 2, motor_speed_cmd * dir, "yaw_rover");
		rover.move_rover(rover, 3, motor_speed_cmd * dir, "yaw_rover");
		rover.move_rover(rover, 4, motor_speed_cmd * dir, "yaw_rover");
	} else {
		rover.move_rover(rover, 1, 0, "yaw_rover");
		rover.move_rover(rover, 2, 0, "yaw_rover");
		rover.move_rover(rover, 3, 0, "yaw_rover");
		rover.move_rover(rover, 4, 0, "yaw_rover");
	}
};


module.exports = yaw_rover;
