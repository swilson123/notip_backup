const LDR_PKG_HEADER = 0x54;
const LDR_PKG_VER_LEN = 0x2c;
const LDR_PACKET_LEN = 47; // header + ver_len + speed + start_angle + 12*(distance+confidence) + end_angle + timestamp + crc8

var connect_to_ldr = function (white_rabbit) {
//Model STL-19P

    if (!white_rabbit.ldr.enabled) {
        console.log('ldr disabled in setup.json');
        return;
    }

    white_rabbit.connect_to_ldr_display(white_rabbit);

    if (white_rabbit.ldr.port_path) {

        white_rabbit.ldr.serial = new white_rabbit.SerialPort({path: white_rabbit.ldr.port_path, baudRate: white_rabbit.ldr.baudrate});

        white_rabbit.ldr.serial.on('open', function () {

            console.log('Connected to ldr on port: ' + white_rabbit.ldr.port_path);

            white_rabbit.logs.ldr_message_handler.log(white_rabbit, 'Connected to ldr on port: ' + white_rabbit.ldr.port_path);

            white_rabbit.ldr.connected = true;

            white_rabbit.ldr_edge_data(white_rabbit);

            // The STL-19P streams fixed-length packets continuously with no
            // request/response handshake. This buffer holds whatever bytes have
            // arrived so far and pulls out one CRC-validated packet at a time,
            // resyncing a byte at a time whenever the header or checksum doesn't land.
            let _byte_buf = Buffer.alloc(0);

            white_rabbit.ldr.serial.on('data', function (chunk) {

                _byte_buf = Buffer.concat([_byte_buf, chunk]);

                while (_byte_buf.length >= LDR_PACKET_LEN) {

                    if (_byte_buf[0] !== LDR_PKG_HEADER || _byte_buf[1] !== LDR_PKG_VER_LEN) {
                        _byte_buf = _byte_buf.subarray(1);
                        continue;
                    }

                    const candidate = _byte_buf.subarray(0, LDR_PACKET_LEN);

                    if (white_rabbit.calc_ldr_crc8(candidate.subarray(0, LDR_PACKET_LEN - 1)) === candidate[LDR_PACKET_LEN - 1]) {
                        white_rabbit.ldr_message_handler(white_rabbit, candidate);
                        _byte_buf = _byte_buf.subarray(LDR_PACKET_LEN);
                    } else {
                        _byte_buf = _byte_buf.subarray(1);
                    }
                }
            });

        });

        white_rabbit.ldr.serial.on('close', function (e) {

            console.log('white_rabbit.ldr.serial close: ', e);
            white_rabbit.ldr.connected = false;

        });

        white_rabbit.ldr.serial.on('error', function (e) {

            console.log('white_rabbit.ldr.serial error: ', e);

        });


    }
    else{
        console.log('No ldr port defined');
    }
};

module.exports = connect_to_ldr;
