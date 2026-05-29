var calc_motor_rpm_value = function (white_rabbit, rpm) {

    if (white_rabbit.motor.motor_type === "ZLAC8015D") {

        if (rpm < 0) {
            return 65536 + (rpm * white_rabbit.motor.throttle_percentage);
        }
        else {
            return rpm * white_rabbit.motor.throttle_percentage;
        }

    }
    else {
        return rpm * white_rabbit.motor.throttle_percentage;
    }

}

module.exports = calc_motor_rpm_value;