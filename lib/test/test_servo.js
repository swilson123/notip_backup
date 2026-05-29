var test_servo_pwm = function (white_rabbit) {

    console.log('Testing Direct PWM Override');

    // Ensure connection to physical hardware

    white_rabbit.set_flight_mode(white_rabbit, 'Guided');

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
        var rc_response = white_rabbit.mavlink_messages.RC_CHANNELS_OVERRIDE(white_rabbit, rc_data);
        white_rabbit.send_pixhawk_command(white_rabbit, rc_response[0], rc_response[1], null);



    }, 1000);
};

module.exports = test_servo_pwm;