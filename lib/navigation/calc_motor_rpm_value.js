var calc_motor_rpm_value = function (rover, rpm) {

    if (rover.motor.motor_type === "ZLAC8015D") {

        if (rpm < 0) {
            return 65536 + (rpm * rover.motor.throttle_percentage);
        }
        else {
            return rpm * rover.motor.throttle_percentage;
        }

    }
    else {
        return rpm * rover.motor.throttle_percentage;
    }

}

module.exports = calc_motor_rpm_value;