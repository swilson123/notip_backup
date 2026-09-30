// Crab walk — same starting point as yaw_white_rabbit's spin-in-place
// (lib/navigation/yaw_white_rabbit.js: all four steering servos driven to
// the same raw PWM, 1750, which is the field-validated pivot-turn toe
// angle), but continued the same direction all the way to CRAB_STEER_PWM —
// near the servos' mechanical end stop — so the wheels sit "horizontal":
// perpendicular to the chassis instead of tangent to a spin circle. With
// the wheels locked there, driving all four in the same direction
// translates the chassis sideways instead of rotating it, and reversing
// that same motor sign crabs back the other way — no re-steering needed
// between legs, same as a train reversing on fixed rails.
//
// This is a one-shot command, same contract as yaw_white_rabbit: the
// caller re-issues it every tick and owns the closed loop (how far/how
// long to crab). Per-tick because, same as yaw_white_rabbit, motors are
// gated off until the steering servos actually reach the crab angle —
// applying drive force while a servo is still travelling from 1500/1750
// toward CRAB_STEER_PWM would stress the drivetrain against the
// direction it's trying to turn.
//
// UNVERIFIED on real hardware: yaw_white_rabbit proves uniform-PWM +
// uniform-motor-sign works at the 1750 spin angle; this assumes the same
// two conventions still hold at full lock. If Noah instead drives
// forward/back or binds up, the first things to check are (a) whether
// CRAB_STEER_PWM needs to back off further from the mechanical end stop,
// and (b) whether the motor sign needs to flip per side at this angle
// (unlike at the spin angle) — see calc_steering_and_rpm.js for how
// normal Ackermann driving does mirror driver/passenger motor sign.
var CRAB_STEER_PWM = 2450;   // near full lock (2500) — leaves mechanical headroom
var CRAB_STEER_PWM_MIN = 2400;
var CRAB_STEER_PWM_MAX = 2500;

var crab_white_rabbit = function (white_rabbit, motor_speed_cmd) {
	if (motor_speed_cmd > 50) motor_speed_cmd = 50;
	if (motor_speed_cmd < -50) motor_speed_cmd = -50;

	white_rabbit.servo_send_command(white_rabbit, 11, CRAB_STEER_PWM, true);
	white_rabbit.servo_send_command(white_rabbit, 12, CRAB_STEER_PWM, true);
	white_rabbit.servo_send_command(white_rabbit, 13, CRAB_STEER_PWM, true);
	white_rabbit.servo_send_command(white_rabbit, 14, CRAB_STEER_PWM, true);

	// Wait until all four steering servos have actually reached the crab
	// angle before commanding motors — mirrors yaw_white_rabbit's
	// servos_in_position gate.
	const servos_in_position =
		white_rabbit.servos.motor_front_driver.set_pwm    > CRAB_STEER_PWM_MIN && white_rabbit.servos.motor_front_driver.set_pwm    <= CRAB_STEER_PWM_MAX &&
		white_rabbit.servos.motor_back_driver.set_pwm     > CRAB_STEER_PWM_MIN && white_rabbit.servos.motor_back_driver.set_pwm     <= CRAB_STEER_PWM_MAX &&
		white_rabbit.servos.motor_front_passenger.set_pwm > CRAB_STEER_PWM_MIN && white_rabbit.servos.motor_front_passenger.set_pwm <= CRAB_STEER_PWM_MAX &&
		white_rabbit.servos.motor_back_passenger.set_pwm  > CRAB_STEER_PWM_MIN && white_rabbit.servos.motor_back_passenger.set_pwm  <= CRAB_STEER_PWM_MAX;

	if (servos_in_position && motor_speed_cmd !== 0) {
		white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd, "crab_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "crab_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "crab_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "crab_white_rabbit");
	} else {
		white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "crab_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "crab_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "crab_white_rabbit");
		white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "crab_white_rabbit");
	}
};

module.exports = crab_white_rabbit;
