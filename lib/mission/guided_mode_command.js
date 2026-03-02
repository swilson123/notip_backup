var guided_mode_command = function(rover, x, y, z, yaw) {

    //x: - Pitch back, + Pitch Forward.
    //y: -Roll left, +Roll Right
    //z: +Desc, -Asc
    //Send Guided Command before
     rover.set_flight_mode(rover, 'Guided');
    console.log('guided_mode_command: Starting with RCPassthru servo setup for yaw control');
    
    // Store original servo functions to restore later
    var original_functions = {
        servo1: 74, // ThrottleRight
        servo2: 74, // ThrottleRight  
        servo3: 73, // ThrottleLeft
        servo4: 73  // ThrottleLeft
    };
    
    // Set all servos to RCPassthru (function = 1) before yaw command
    var param_changes = [
        { param: 'SERVO1_FUNCTION', value: 1 },
        { param: 'SERVO2_FUNCTION', value: 1 },
        { param: 'SERVO3_FUNCTION', value: 1 },
        { param: 'SERVO4_FUNCTION', value: 1 }
    ];
    
    var param_index = 0;
    
    function setNextParam() {
        if (param_index >= param_changes.length) {
            console.log('All servos set to RCPassthru - sending yaw command in 100 milliseconds');
            setTimeout(sendYawCommand, 100);
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
    
    function sendYawCommand() {
        console.log('Sending SET_POSITION_TARGET_LOCAL_NED command with yaw control');
        
        if (yaw) {
            //North is 0 or 360 degrees
            var yaw_degrees = rover.robot_data.VFR_HUD.heading + yaw;

            if (yaw_degrees > 360) {
                yaw_degrees = yaw_degrees - 360;
            }
            else if (yaw < 0) {
                yaw_degrees = 360 + yaw;
            }

            yaw = (yaw_degrees) * Math.PI / 180;
            console.log('Target yaw degrees:', yaw_degrees.toFixed(2), '° (', yaw.toFixed(3), 'rad)');
        }

        var data = {
            time_usec: Date.now(),
            frame: rover.guided_mode_command_robot.mav_frame,
            type_mask: 0b0000001111111111,
            x: x,
            y: y,
            z: z,
            vx: null,
            vy: null,
            vz: null,
            afx: null,
            afy: null,
            afz: null,
            yaw: yaw,
            yaw_rate: rover.guided_mode_command_robot.yaw_rate
        };

        var mav_response = rover.mavlink_messages.SET_POSITION_TARGET_LOCAL_NED(rover, data);
        rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);

        console.log('SET_POSITION_TARGET_LOCAL_NED command sent - switching to Guided mode');
        
        setTimeout(function() {
           
            
            // Wait a bit for the command to take effect, then restore servo functions
            setTimeout(restoreServoFunctions, 3000);
            
        }, 1000);
    }
    
    function restoreServoFunctions() {
        console.log('Restoring original servo functions after yaw command');
        
        // Restore original servo functions
        var restore_params = [
            { param: 'SERVO1_FUNCTION', value: original_functions.servo1 },
            { param: 'SERVO2_FUNCTION', value: original_functions.servo2 },
            { param: 'SERVO3_FUNCTION', value: original_functions.servo3 },
            { param: 'SERVO4_FUNCTION', value: original_functions.servo4 }
        ];
        
        var restore_index = 0;
        
        function restoreNextParam() {
            if (restore_index >= restore_params.length) {
                console.log('All servo functions restored - guided mode command complete');
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
    console.log('Starting RCPassthru setup for guided mode yaw command');
    setNextParam();
};

module.exports = guided_mode_command;