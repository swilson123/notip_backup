var test_servo_pwm = function (rover) {

    console.log('Testing Direct PWM Override');

    // Ensure connection to physical hardware

    rover.set_flight_mode(rover, 'Guided');

    setInterval(function () {
              var rc_data = {
            chan1_raw: 1800,  // Right track forward (servos 1&2)
            chan2_raw: 65535, // Release override
            chan3_raw: 1200,  // Left track reverse (servos 3&4)  
            chan4_raw: 65535, // Release override
            chan5_raw: 65535, // Release override
            chan6_raw: 65535, // Release override
            chan7_raw: 65535, // Release override
            chan8_raw: 65535  // Release override
        };

        console.log('Setting RC Override - Right: 1800, Left: 1200');
        var rc_response = rover.mavlink_messages.RC_CHANNELS_OVERRIDE(rover, rc_data);
        rover.send_pixhawk_command(rover, rc_response[0], rc_response[1], null);



    }, 1000);
};

module.exports = test_servo_pwm;