var preform_turn = function (rover, degrees) {
    return new Promise(function(resolve, reject) {

        rover.set_flight_mode(rover, 'Manual');

        console.log('preform_turn: Starting ' + degrees + '° turn using RCPassthru mode');

        // Store original servo functions to restore later
        var original_functions = {
            servo1: 74, // ThrottleRight
            servo2: 74, // ThrottleRight  
            servo3: 73, // ThrottleLeft
            servo4: 73  // ThrottleLeft
        };
        
        // Set all servos to RCPassthru (function = 1)
        var param_changes = [
            { param: 'SERVO1_FUNCTION', value: 1 },
            { param: 'SERVO2_FUNCTION', value: 1 },
            { param: 'SERVO3_FUNCTION', value: 1 },
            { param: 'SERVO4_FUNCTION', value: 1 }
        ];
        
        var param_index = 0;
        
        function setNextParam() {
            if (param_index >= param_changes.length) {
                console.log('All servos set to RCPassthru - starting ' + degrees + '° turn in 2 seconds');
                setTimeout(startTurn, 2000);
                return;
            }
            
            var param_change = param_changes[param_index];
            console.log('Setting', param_change.param, 'to', param_change.value, '(RCPassthru)');
            
            // Send parameter set command
            var param_data = {
                param_id: param_change.param,
                param_value: param_change.value,
                param_type: 2 // MAV_PARAM_TYPE_UINT8
            };
            
            var param_response = rover.mavlink_messages.PARAM_SET(rover, param_data);
            rover.send_pixhawk_command(rover, param_response[0], param_response[1], null);
            
            param_index++;
            setTimeout(setNextParam, 100);
        }
        
        function startTurn() {
            console.log('Step 2: Starting ' + degrees + '° turn with consistent direction until overshoot');
            
            // Get current heading
            var start_heading = rover.robot_data.ATTITUDE ? (rover.robot_data.ATTITUDE.yaw * 180 / Math.PI) : 0;
            
            // Normalize heading to 0-360 degrees
            if (start_heading < 0) start_heading += 360;
            
            // Calculate target heading
            var target_heading = start_heading + degrees;
            while (target_heading >= 360) target_heading -= 360;
            while (target_heading < 0) target_heading += 360;
            
            console.log('Start heading:', start_heading.toFixed(2), '° - Target heading:', target_heading.toFixed(2), '° - Turn amount:', degrees, '°');
            
            // Determine initial turn direction based on degrees
            var initial_turn_direction = (degrees >= 0) ? 'LEFT' : 'RIGHT';
            var current_turn_direction = initial_turn_direction;
            var has_overshot = false;
            
            console.log('Initial turn direction: ' + initial_turn_direction + ' (will continue until overshoot)');
            
            var yaw_tolerance = Math.max(10, Math.abs(degrees) * 0.1); // Dynamic tolerance based on turn amount
            var running = true;
            var turn_interval;
            var last_heading = start_heading;
            var stable_count = 0;
            var turn_start_time = Date.now();
            var aggressive_phase = true;
            var minimum_turn_completed = false;
            var minimum_turn_threshold = Math.min(90, Math.abs(degrees) * 0.5); // 50% of turn or 90°, whichever is smaller
            
            function performTurn() {
                if (!running) return;
                
                // Get current heading
                var current_heading = rover.robot_data.ATTITUDE ? (rover.robot_data.ATTITUDE.yaw * 180 / Math.PI) : start_heading;
                if (current_heading < 0) current_heading += 360;
                
                // Calculate how much we've turned from start
                var turned_amount_raw = current_heading - start_heading;
                
                // Handle wraparound for turned amount calculation
                if (degrees > 0) { // LEFT turn
                    if (turned_amount_raw < 0) turned_amount_raw += 360;
                } else { // RIGHT turn  
                    if (turned_amount_raw > 0) turned_amount_raw -= 360;
                }
                
                var turned_amount = Math.abs(turned_amount_raw);
                
                // Calculate heading error (how far from target)
                var heading_diff = target_heading - current_heading;
                if (heading_diff > 180) heading_diff -= 360;
                if (heading_diff < -180) heading_diff += 360;
                
                // Check if we've overshot the target
                var previous_error = target_heading - last_heading;
                if (previous_error > 180) previous_error -= 360;
                if (previous_error < -180) previous_error += 360;
                
                // Detect overshoot: error changes sign and we've turned past minimum
                if (!has_overshot && minimum_turn_completed && 
                    Math.sign(heading_diff) !== Math.sign(previous_error) && 
                    Math.abs(previous_error) > 5) {
                    
                    console.log('*** OVERSHOOT DETECTED! Reversing direction ***');
                    console.log('Previous error:', previous_error.toFixed(2), '° Current error:', heading_diff.toFixed(2), '°');
                    has_overshot = true;
                    current_turn_direction = (initial_turn_direction === 'LEFT') ? 'RIGHT' : 'LEFT';
                    aggressive_phase = false; // Switch to precision after overshoot
                }
                
                console.log('Current heading:', current_heading.toFixed(2), '° - Error:', heading_diff.toFixed(2), '° - Turned:', turned_amount.toFixed(1), '° - Direction:', current_turn_direction);
                
                // Check if we've completed minimum turn
                if (turned_amount >= minimum_turn_threshold) {
                    minimum_turn_completed = true;
                    if (aggressive_phase && !has_overshot) {
                        console.log('*** ' + minimum_turn_threshold.toFixed(0) + '° MINIMUM COMPLETED - Continuing same direction until overshoot ***');
                    }
                }
                
                // Only allow completion if minimum turn is done
                if (minimum_turn_completed && Math.abs(heading_diff) < yaw_tolerance) {
                    stable_count++;
                    console.log('Within tolerance (' + yaw_tolerance.toFixed(1) + '°)! Stable count:', stable_count);
                    
                    if (stable_count >= 2) {
                        console.log('Turn complete! Final heading:', current_heading.toFixed(2), '° - Total turned:', turned_amount.toFixed(1), '°');
                        
                        // Stop all servos (set to neutral 1500)
                        stopAllServos();
                        
                        clearInterval(turn_interval);
                        running = false;
                        
                        // Restore original servo functions
                        restoreServoFunctions();
                        return;
                    }
                } else {
                    stable_count = 0;
                }
                
                // Calculate turn speed based on phase and turn magnitude
                var error_abs = Math.abs(heading_diff);
                var turn_speed;
                var elapsed_time = (Date.now() - turn_start_time) / 1000;
                
                // Base speed on turn magnitude
                var base_speed = Math.min(180, Math.max(100, Math.abs(degrees) * 1.5));
                
                if (aggressive_phase && !has_overshot) {
                    // AGGRESSIVE PHASE: High power until overshoot
                    console.log('AGGRESSIVE PHASE: High power turning in ' + current_turn_direction + ' direction');
                    turn_speed = base_speed;
                    
                    // Boost if stuck
                    var heading_change = Math.abs(current_heading - last_heading);
                    if (heading_change < 2.0 && elapsed_time > 3) {
                        console.log('Rover stuck in aggressive phase - MAX POWER!');
                        turn_speed = Math.min(220, base_speed * 1.2);
                    }
                    
                } else {
                    // PRECISION PHASE: Controlled power after overshoot
                    console.log('PRECISION PHASE: Controlled power turning in ' + current_turn_direction + ' direction');
                    
                    if (error_abs > 60) {
                        turn_speed = Math.min(120, base_speed * 0.7);
                    } else if (error_abs > 40) {
                        turn_speed = Math.min(90, base_speed * 0.5);
                    } else if (error_abs > 20) {
                        turn_speed = Math.min(60, base_speed * 0.35);
                    } else {
                        turn_speed = Math.min(40, base_speed * 0.25);
                    }
                    
                    // Boost if not moving in precision phase
                    var heading_change = Math.abs(current_heading - last_heading);
                    if (heading_change < 1.0 && error_abs > yaw_tolerance && elapsed_time > 10) {
                        console.log('Rover not turning in precision phase - boosting power');
                        turn_speed = Math.min(turn_speed * 1.5, 140);
                    }
                }
                
                // Apply turn based on current direction
                if (current_turn_direction === 'LEFT') {
                    // Turn LEFT (counterclockwise)
                    console.log('Turning LEFT with speed:', turn_speed);
                    
                    // Right side motors FORWARD (SERVO1&2 REVERSED)
                    sendServoCommand(1, 1500 - turn_speed);
                    sendServoCommand(2, 1500 - turn_speed);
                    
                    // Left side motors REVERSE (SERVO3&4 normal)
                    sendServoCommand(3, 1500 - turn_speed);
                    sendServoCommand(4, 1500 - turn_speed);
                    
                } else {
                    // Turn RIGHT (clockwise)  
                    console.log('Turning RIGHT with speed:', turn_speed);
                    
                    // Right side motors REVERSE (SERVO1&2 REVERSED)
                    sendServoCommand(1, 1500 + turn_speed);
                    sendServoCommand(2, 1500 + turn_speed);
                    
                    // Left side motors FORWARD (SERVO3&4 normal)
                    sendServoCommand(3, 1500 + turn_speed);
                    sendServoCommand(4, 1500 + turn_speed);
                }
                
                last_heading = current_heading;
            }
            
            function sendServoCommand(servo_num, pwm_value) {
                var servo_data = { servo_num: servo_num, pwm: pwm_value };
                var servo_response = rover.mavlink_messages.MAV_CMD_DO_SET_SERVO(rover, servo_data);
                rover.send_pixhawk_command(rover, servo_response[0], servo_response[1], null);
            }
            
            function stopAllServos() {
                console.log('Stopping all servos - setting to neutral (1500)');
                for (var i = 1; i <= 4; i++) {
                    sendServoCommand(i, 1500);
                }
            }
            
            // Start the turning loop
            console.log('Starting ' + degrees + '° turn (continue until overshoot, then correct)');
            turn_interval = setInterval(performTurn, 300);
            
            // Dynamic timeout based on turn magnitude
            var timeout = Math.max(30000, Math.abs(degrees) * 500); // At least 30s, or 500ms per degree
            setTimeout(function() {
                if (running) {
                    console.log('Safety timeout reached - stopping turn');
                    stopAllServos();
                    clearInterval(turn_interval);
                    running = false;
                    restoreServoFunctions();
                }
            }, timeout);
        }
        
        function restoreServoFunctions() {
            console.log('Step 3: Restoring original servo functions');
            
            var restore_params = [
                { param: 'SERVO1_FUNCTION', value: original_functions.servo1 },
                { param: 'SERVO2_FUNCTION', value: original_functions.servo2 },
                { param: 'SERVO3_FUNCTION', value: original_functions.servo3 },
                { param: 'SERVO4_FUNCTION', value: original_functions.servo4 }
            ];
            
            var restore_index = 0;
            
            function restoreNextParam() {
                if (restore_index >= restore_params.length) {
                    console.log('All servo functions restored - turn completed');
                    setTimeout(function() {
                        resolve(); // Resolve the promise when turn is complete
                    }, 1000);
                    return;
                }
                
                var restore_param = restore_params[restore_index];
                console.log('Restoring', restore_param.param, 'to', restore_param.value);
                
                var param_data = {
                    param_id: restore_param.param,
                    param_value: restore_param.value,
                    param_type: 2
                };
                
                var param_response = rover.mavlink_messages.PARAM_SET(rover, param_data);
                rover.send_pixhawk_command(rover, param_response[0], param_response[1], null);
                
                restore_index++;
                setTimeout(restoreNextParam, 100);
            }
            
            restoreNextParam();
        }
        
        // Start the parameter setting sequence
        setNextParam();
    });
};

module.exports = preform_turn;