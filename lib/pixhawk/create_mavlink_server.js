var create_mavlink_server = function(white_rabbit)
	{
		if (white_rabbit.truck.on)
		{
			if (!white_rabbit.mavlink_port.server)
			{
				white_rabbit.mavlink_port.server = white_rabbit.net.createServer(function(sock)
				{

					white_rabbit.mavlink_port.mavlink_socket = sock;
					white_rabbit.mavlink_port.connected = true;


					console.log('New Mavlink Sock...........................');

					white_rabbit.mavlink_port.mavlink_socket.on('data', function(data)
					{
						//send data back to robot
						if (white_rabbit.pixhawk_port.serial)
						{
							white_rabbit.pixhawk_port.serial.write(data);
						}
					});

					white_rabbit.mavlink_port.mavlink_socket.on('error', function(data)
					{
						console.log('Mavlink socket error');
						white_rabbit.mavlink_port.connected = false;
					});

					white_rabbit.mavlink_port.mavlink_socket.on('close', function(e)
					{
						console.log('Mavlink socket closed');
						white_rabbit.mavlink_port.connected = false;


					});

				});

				white_rabbit.mavlink_port.server.on('error', function(e)
				{
					if (e.code == 'EADDRINUSE')
					{
						console.log('mavlink_port address in use, retrying...');
						setTimeout(function()
						{
							white_rabbit.mavlink_port.server.close();
							white_rabbit.mavlink_port.server.listen(white_rabbit.mavlink_port.port, white_rabbit.mavlink_port.ip_address);
						}, 1000);
					}
				});

				white_rabbit.mavlink_port.server.listen(white_rabbit.mavlink_port.port, white_rabbit.mavlink_port.ip_address);
			}
		}
	};


module.exports = create_mavlink_server;