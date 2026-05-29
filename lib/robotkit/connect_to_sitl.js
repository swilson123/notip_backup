var connect_to_sitl = function(white_rabbit)
	{

		white_rabbit.sitl.client = new white_rabbit.net.Socket();


		white_rabbit.sitl.client.connect(white_rabbit.sitl.port, white_rabbit.sitl.host, function()
		{


			white_rabbit.logs.server.log(white_rabbit, "SITL Port is open");


			white_rabbit.pixhawk_port.mavlink = new MAVLink(null, white_rabbit.pixhawk_port.targetSystem, white_rabbit.pixhawk_port.targetComponent);
			white_rabbit.pixhawk_port.connected = true;

			white_rabbit.request_data_stream(white_rabbit);

			


			white_rabbit.sitl.client.on('data', function(data)
			{

				white_rabbit.pixhawk_port.mavlink.parseBuffer(data);
			});

			//On pixhawk usb/serial port message...........................
			white_rabbit.pixhawk_port.mavlink.on("message", function(message)
			{
				//console.log(message);
				white_rabbit.pixhawk_message_handler(white_rabbit, message);

			});

		});


		white_rabbit.sitl.client.on('close', function()
		{

			white_rabbit.logs.server.log(white_rabbit, "SITL Connection closed");
			setTimeout(function()
			{
				white_rabbit.init_robotkit(white_rabbit);
				white_rabbit.connect_to_sitl(white_rabbit);
			}, 3000);
		});


		white_rabbit.sitl.client.on('error', function()
		{

			white_rabbit.logs.server.log(white_rabbit, "SITL Connection error");
		});

	};


module.exports = connect_to_sitl;