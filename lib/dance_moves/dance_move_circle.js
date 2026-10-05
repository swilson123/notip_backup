// Dance move — drive in a circle (as opposed to spinning in place).
//
// Reuses the same 2-wheel/Ackermann steering pipeline run_mission.js drives
// with on a normal outbound leg (see run_mission.js's "all wheel" branch):
// calc_steering_and_rpm() → angle_to_pwm() → servo_send_command() for the
// four steering servos (11/12/13/14), then move_white_rabbit() for the
// four drive motors (1/2/3/4) using the returned motor_rpm mapping.
//
// Geometry check against the "contained in a 10x10 ft area" requirement,
// using the wheelbase/track constants from calc_steering_and_rpm.js
// (wheelbase_in=13, track_width_in=14.5, half_wheelbase=6.5in):
//   at CIRCLE_STEERING_DEG=25°, radius_center = 6.5 / tan(25°) ≈ 13.9 in
//   outer_radius = radius_center + track_width/2 ≈ 13.9 + 7.25 ≈ 21.2 in
//   outer wheel path diameter ≈ 2 × 21.2 in ≈ 3.5 ft
// Adding the rover's own ~14.5in track width as clearance on each side
// still keeps the whole swept path under 6 ft across — well inside a
// 10x10 ft area, with margin to spare.
//
// Direction (left/right) is randomised per call. Closed-loop on
// ATTITUDE.yaw the same way dance_move_spin_in_place.js is, so one call
// means one full lap, not a fixed time that could over- or under-shoot.

const { signed_angle_delta_rad } = require('./dance_utils');

const TICK_MS = 50;
const TARGET_DEG = 360;
const SAFETY_TIMEOUT_MS = 15000;
const CIRCLE_STEERING_DEG = 25;

var center_steering = function (white_rabbit) {
	white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
	white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
	white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
	white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
};

var stop_drive_motors = function (white_rabbit) {
	white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dance_move_circle');
	white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dance_move_circle');
	white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dance_move_circle');
	white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dance_move_circle');
};

var dance_move_circle = function (white_rabbit) {
	return new Promise(function (resolve) {
		const rpm = (white_rabbit.dance_moves_config && white_rabbit.dance_moves_config.circle_rpm) || 20;
		const turn_left = Math.random() < 0.5;
		const steering_deg = turn_left ? CIRCLE_STEERING_DEG : -CIRCLE_STEERING_DEG;
		console.log('dance_moves: drive in a circle (' + (turn_left ? 'left' : 'right') + ')');

		const steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, steering_deg, rpm);
		white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
		white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
		white_rabbit.servo_send_command(white_rabbit, 12, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
		white_rabbit.servo_send_command(white_rabbit, 14, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);

		const start_yaw = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
			? white_rabbit.robot_data.ATTITUDE.yaw : null;
		const signed_dir = turn_left ? 1 : -1;   // matches yaw_white_rabbit/nudge_spin convention: +1 = CW = right... here we track whichever way the circle actually turns

		function finish(timed_out) {
			stop_drive_motors(white_rabbit);
			center_steering(white_rabbit);
			if (timed_out) console.error('dance_moves: circle timed out before completing a lap');
			resolve();
		}

		function drive_tick() {
			white_rabbit.move_white_rabbit(white_rabbit, 1, steering_and_rpm.motor_rpm.front_passenger, 'dance_move_circle');
			white_rabbit.move_white_rabbit(white_rabbit, 2, steering_and_rpm.motor_rpm.back_passenger, 'dance_move_circle');
			white_rabbit.move_white_rabbit(white_rabbit, 3, steering_and_rpm.motor_rpm.front_driver, 'dance_move_circle');
			white_rabbit.move_white_rabbit(white_rabbit, 4, steering_and_rpm.motor_rpm.back_driver, 'dance_move_circle');
		}

		if (start_yaw == null) {
			// No yaw feedback — fall back to a fixed-time lap at this rpm/radius.
			const t_start = Date.now();
			const ms_drive = 4000;
			const interval = setInterval(function () {
				const cancelled = white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested;
				if (Date.now() - t_start >= ms_drive || cancelled) {
					clearInterval(interval);
					finish(false);
					return;
				}
				drive_tick();
			}, TICK_MS);
			return;
		}

		const target_rad = TARGET_DEG * Math.PI / 180;
		let prev_yaw = start_yaw;
		let progress_rad = 0;
		const t_start = Date.now();

		const interval = setInterval(function () {
			drive_tick();

			const cur_yaw = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
				? white_rabbit.robot_data.ATTITUDE.yaw : null;
			if (cur_yaw != null) {
				progress_rad += signed_angle_delta_rad(prev_yaw, cur_yaw) * signed_dir;
				prev_yaw = cur_yaw;
			}

			const timed_out = (Date.now() - t_start) >= SAFETY_TIMEOUT_MS;
			const cancelled = white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested;
			if (progress_rad >= target_rad || timed_out || cancelled) {
				clearInterval(interval);
				finish(timed_out);
			}
		}, TICK_MS);
	});
};

module.exports = dance_move_circle;
