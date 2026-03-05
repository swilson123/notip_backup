var pwm_to_angle = function (pwm1) {
    var minAngle = -90;
    var maxAngle = 90;
    var minPwm = 500;
    var maxPwm = 2500;
    var trim = 1500;

    // Clamp PWM
    const clampedPwm1 = Math.max(minPwm, Math.min(maxPwm, pwm1));

    const posRange = maxPwm - trim; // +90°
    const negRange = trim - minPwm; // -90°

    var angle1;

    if (clampedPwm1 >= trim) {
        angle1 = ((clampedPwm1 - trim) / posRange) * maxAngle;
    } else {
        angle1 = ((clampedPwm1 - trim) / negRange) * -minAngle;
    }

    return Math.round(angle1);
}


module.exports = pwm_to_angle;