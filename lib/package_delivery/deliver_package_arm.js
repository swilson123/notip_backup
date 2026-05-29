var deliver_package_arm = function (white_rabbit) {

    let speed = 1;
    let rate = 10;


    //deliver package with arm delivery to max pwm
    const interval = setInterval(() => {
        if (white_rabbit.servos.arm_driver_side.set_pwm >= white_rabbit.servos.arm_driver_side.max_pwm) {
            clearInterval(interval); // Stop when below 800
            return;
        }
        if (white_rabbit.delivery_device === 'arm_delivery') {
            white_rabbit.servo_arm_passenger_side(white_rabbit, white_rabbit.servos.arm_driver_side.set_pwm);
        }
        else {
            clearInterval(interval); // Stop if delivery device changed
            return;
        }
        // Decrement
        white_rabbit.servos.arm_driver_side.set_pwm += speed;

    }, rate);


    const interval2 = setInterval(() => {
        if (white_rabbit.servos.arm_passenger_side.set_pwm < white_rabbit.servos.arm_passenger_side.max_pwm) {
            clearInterval(interval2); // Stop when below 800
            return;
        }
        if (white_rabbit.delivery_device === 'arm_delivery') {
            white_rabbit.servo_arm_driver_side(white_rabbit, white_rabbit.servos.arm_passenger_side.set_pwm);
        }
        else {
            clearInterval(interval2); // Stop if delivery device changed
            return;
        }
        // Decrement
        white_rabbit.servos.arm_passenger_side.set_pwm -= speed;

    }, rate);




    //set arm delivery to trim pwm
    setTimeout(() => {


        const interval3 = setInterval(() => {
            if (white_rabbit.servos.arm_driver_side.set_pwm <= white_rabbit.servos.arm_driver_side.trim_pwm) {
                clearInterval(interval3); // Stop when below 800
                return;
            }
            if (white_rabbit.delivery_device === 'arm_delivery') {
                white_rabbit.servo_arm_passenger_side(white_rabbit, white_rabbit.servos.arm_driver_side.set_pwm);
            }
            else {
                clearInterval(interval3); // Stop if delivery device changed
                return;
            }
            // Decrement
            white_rabbit.servos.arm_driver_side.set_pwm -= speed;

        }, rate);


        const interval4 = setInterval(() => {
            if (white_rabbit.servos.arm_passenger_side.set_pwm >= white_rabbit.servos.arm_passenger_side.trim_pwm) {
                clearInterval(interval4); // Stop when below 800
                return;
            }
            if (white_rabbit.delivery_device === 'arm_delivery') {
                white_rabbit.servo_arm_driver_side(white_rabbit, white_rabbit.servos.arm_passenger_side.set_pwm);
            }
            else {
                clearInterval(interval4); // Stop if delivery device changed
                return;
            }
            // Decrement
            white_rabbit.servos.arm_passenger_side.set_pwm += speed;

        }, rate);

    }, 15000);

};
module.exports = deliver_package_arm;