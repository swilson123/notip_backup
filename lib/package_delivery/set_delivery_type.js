var set_delivery_type = function (rover, gpio_value) {


    if (gpio_value === '1') {
        rover.delivery_device = 'arm_delivery';
        rover.set_arm_delivery(rover);

    } else {
        rover.delivery_device = 'dump_trailer';
        rover.set_dump_trailer_delivery(rover);
    }


    console.log(`Delivery device set to: ${rover.delivery_device}`);

};


module.exports = set_delivery_type;