var opposite_pwm = function (pwm) {
    var minPwm = 500;
    var maxPwm = 2500;
    var trim = 1500;

    const mirrored = trim - (pwm - trim);
    const clamped = Math.max(minPwm, Math.min(maxPwm, mirrored));

    return Math.round(clamped);
}

module.exports = opposite_pwm;