var carrot = function (white_rabbit) {
    //if noah is huging the left add degrees
    //if noah is huging the right subtract degreees

   var carrot_offset_degrees = 7;

    return white_rabbit.realsense.path_detection.x_angle_deg + carrot_offset_degrees;
};
module.exports = carrot;
