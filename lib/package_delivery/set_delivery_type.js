var set_delivery_type = function (white_rabbit, gpio_value) {


    if (gpio_value === '1') {
        white_rabbit.delivery_device = 'arm_delivery';
        white_rabbit.set_arm_delivery(white_rabbit);

    } else {
        white_rabbit.delivery_device = 'dump_trailer';
        white_rabbit.set_dump_trailer_delivery(white_rabbit);
    }


    console.log(`Delivery device set to: ${white_rabbit.delivery_device}`);

};


module.exports = set_delivery_type;