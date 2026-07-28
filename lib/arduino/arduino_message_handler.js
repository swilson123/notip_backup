
var arduino_message_handler = function (white_rabbit, data) {
	const is_truthy = function (v) {
		return v === true || v === 1 || v === '1' || v === 'true';
	};

	try {
		white_rabbit.arduino.received_data = JSON.parse(data.replaceAll("'", '"'));

		//console.log("Received data: ", white_rabbit.arduino.received_data);

		// Hook released during delivery → the package has dropped. Start the return
		// trip NOW; don't wait for the belt/arm/telescope to finish retracting.
		// We deliberately do NOT send stow_arm here — that sets auto_delivery=false
		// on the Arduino and aborts its retract sequence. Instead the auto-delivery
		// sequence keeps running (retracting while the rover drives home), and the
		// final stow_arm is sent when it completes (block below).
		if (is_truthy(white_rabbit.arduino.received_data.package_dropped)
			&& white_rabbit.mission.finished_package_yaw
			&& !white_rabbit.mission.package_delivered) {
			console.log("Package dropped (hook released) — starting return trip while the arm stows");
			white_rabbit.mission.package_delivered = true;
			white_rabbit.mission.current_mission_seq -= 2;
			if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
				white_rabbit.learning.add('successful_delivery', {
					method: 'hook_release',
					lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
					lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude
				});
			}
		}

		// Auto-delivery finished its own retract sequence (auto_delivery 1 -> 0):
		// stow the arm for the trip home. The return may already be underway from
		// the hook-release block above — that's fine, they run concurrently.
		if (white_rabbit.arduino.received_data.auto_delivery == 0 && white_rabbit.mission.auto_delivery) {
			console.log("Auto-delivery complete — stowing arm");
			if (typeof white_rabbit.create_arduino_message === 'function') {
				white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);
			}
			// Wait for the Arduino to confirm stow complete (gates follow_the_light
			// so boot-time stowed=1 heartbeats can't trigger docking prematurely).
			if (white_rabbit.dock) {
				white_rabbit.dock.awaiting_stow_ack = true;
				white_rabbit.dock.stow_command_sent_at = Date.now();
			}
			white_rabbit.mission.auto_delivery = false;
			// Start the return if the hook-release path didn't already (e.g. the hook
			// switch never tripped). Guarded so the sequence isn't decremented twice.
			if (!white_rabbit.mission.package_delivered) {
				white_rabbit.mission.package_delivered = true;
				white_rabbit.mission.current_mission_seq -= 2;
				if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
					white_rabbit.learning.add('successful_delivery', {
						method: 'arduino',
						lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
						lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude
					});
				}
			}
		}

		if (white_rabbit.dock && white_rabbit.dock.awaiting_stow_ack && is_truthy(white_rabbit.arduino.received_data.stowed)) {
			white_rabbit.dock.awaiting_stow_ack = false;
			if (!white_rabbit.dock.stow_confirmed) {
				white_rabbit.dock.stow_confirmed = true;
				console.log('Arduino reports stowed=true. Starting follow_the_light.');
				white_rabbit.follow_the_light(white_rabbit);
			}
		}


		// //hook limit switch..............................
		// // hook_switch_state is a held level (true the whole time the switch is
		// // closed), so act only on the rising edge — the actual press. Keying on the
		// // held level re-fired every Arduino frame: the instant the operator flipped
		// // back to RC (mission_mode -> false), the next frame saw the hook still
		// // pressed and restarted the mission, making it impossible to leave mission
		// // mode. Same reason the RC mission switch uses the mission_switch_armed latch.
		// // The raw signal is inverted (Arduino reports true when the switch is OPEN,
		// // false when CLOSED), so negate it here to get true = closed/pressed.
		// const hook_now = !is_truthy(white_rabbit.arduino.received_data.hook_switch_state);
		// const hook_pressed_edge = hook_now && !white_rabbit.arduino.hook_switch_prev;
		// white_rabbit.arduino.hook_switch_prev = hook_now;

		// if (hook_pressed_edge && !white_rabbit.robot_data.mission_mode) {

		// 	console.log("Hook switch pressed after undock — starting mission");


		// 	//Record the location of the undock for later use
		// 	white_rabbit.dock.undock_latitude = white_rabbit.robot_data.robot_latitude;
		// 	white_rabbit.dock.undock_longitude = white_rabbit.robot_data.robot_longitude;
		// 	white_rabbit.dock.undock_pitch = white_rabbit.get_pitch(white_rabbit);
		// 	white_rabbit.dock.undock_heading = white_rabbit.get_heading(white_rabbit);
		// 	white_rabbit.start_mission(white_rabbit);
		// }
		// // Return leg: Noah has driven home, aligned to the undock heading, and is
		// // parked in await_dock_command waiting for a human to say "dock now" (the
		// // symmetric twin of the mission-start press above). Either the RC dock
		// // command (handled in run_mission's await_dock_command branch) OR this hook
		// // switch starts follow_the_light. Advance the state machine exactly like the
		// // RC path (run_mission.js) so run_mission's await_dock_command branch stops
		// // zeroing the motors every tick and hands the motors to follow_the_light.
		// else if (hook_pressed_edge
		// 	&& white_rabbit.mission.dock_return_phase === 'await_dock_command') {
		// 	white_rabbit.dock.manual_dock_required = false;
		// 	white_rabbit.mission.dock_return_phase = 'docking';
		// 	white_rabbit.dock.dock_state = null;
		// 	white_rabbit.dock.follow_state = {};
		// 	white_rabbit.dock.awaiting_stow_ack = true;

		// 	console.log('Hook switch pressed at dock — starting follow_the_light');
		// 	clearInterval(white_rabbit.dock.dock_interval);
		// 	white_rabbit.dock.dock_interval = setInterval(() => {

		// 		white_rabbit.follow_the_light(white_rabbit);

		// 	}, 250);
		// }


		white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Received data: ' + JSON.stringify(white_rabbit.arduino.received_data));
	}
	catch (e) {
		// Silently drop malformed fragments — the brace accumulator in
		// connect_to_arduino.js prevents this in normal operation.
		white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'parse error (fragment dropped): ' + data.slice(0, 40));
	}

};

module.exports = arduino_message_handler;
