var deliver_package_arm = function (rover) {

    let speed = 1;
    let rate = 10;


    //deliver package with arm delivery to max pwm
    const interval = setInterval(() => {
        if (rover.servos.arm_driver_side.set_pwm >= rover.servos.arm_driver_side.max_pwm) {
            clearInterval(interval); // Stop when below 800
            return;
        }
        if (rover.delivery_device === 'arm_delivery') {
            rover.servo_arm_passenger_side(rover, rover.servos.arm_driver_side.set_pwm);
        }
        else {
            clearInterval(interval); // Stop if delivery device changed
            return;
        }
        // Decrement
        rover.servos.arm_driver_side.set_pwm += speed;

    }, rate);


    const interval2 = setInterval(() => {
        if (rover.servos.arm_passenger_side.set_pwm < rover.servos.arm_passenger_side.max_pwm) {
            clearInterval(interval2); // Stop when below 800
            return;
        }
        if (rover.delivery_device === 'arm_delivery') {
            rover.servo_arm_driver_side(rover, rover.servos.arm_passenger_side.set_pwm);
        }
        else {
            clearInterval(interval2); // Stop if delivery device changed
            return;
        }
        // Decrement
        rover.servos.arm_passenger_side.set_pwm -= speed;

    }, rate);




    //set arm delivery to trim pwm
    setTimeout(() => {


        const interval3 = setInterval(() => {
            if (rover.servos.arm_driver_side.set_pwm <= rover.servos.arm_driver_side.trim_pwm) {
                clearInterval(interval3); // Stop when below 800
                return;
            }
            if (rover.delivery_device === 'arm_delivery') {
                rover.servo_arm_passenger_side(rover, rover.servos.arm_driver_side.set_pwm);
            }
            else {
                clearInterval(interval3); // Stop if delivery device changed
                return;
            }
            // Decrement
            rover.servos.arm_driver_side.set_pwm -= speed;

        }, rate);


        const interval4 = setInterval(() => {
            if (rover.servos.arm_passenger_side.set_pwm >= rover.servos.arm_passenger_side.trim_pwm) {
                clearInterval(interval4); // Stop when below 800
                return;
            }
            if (rover.delivery_device === 'arm_delivery') {
                rover.servo_arm_driver_side(rover, rover.servos.arm_passenger_side.set_pwm);
            }
            else {
                clearInterval(interval4); // Stop if delivery device changed
                return;
            }
            // Decrement
            rover.servos.arm_passenger_side.set_pwm += speed;

        }, rate);

    }, 15000);

};
module.exports = deliver_package_arm;