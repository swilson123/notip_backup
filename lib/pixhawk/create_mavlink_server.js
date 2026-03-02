var create_mavlink_server = function(rover)
	{
		if (rover.truck.on)
		{
			if (!rover.mavlink_port.server)
			{
				rover.mavlink_port.server = rover.net.createServer(function(sock)
				{

					rover.mavlink_port.mavlink_socket = sock;
					rover.mavlink_port.connected = true;


					console.log('New Mavlink Sock...........................');

					rover.mavlink_port.mavlink_socket.on('data', function(data)
					{
						//send data back to robot
						if (rover.pixhawk_port.serial)
						{
							rover.pixhawk_port.serial.write(data);
						}
					});

					rover.mavlink_port.mavlink_socket.on('error', function(data)
					{
						console.log('Mavlink socket error');
						rover.mavlink_port.connected = false;
					});

					rover.mavlink_port.mavlink_socket.on('close', function(e)
					{
						console.log('Mavlink socket closed');
						rover.mavlink_port.connected = false;


					});

				});

				rover.mavlink_port.server.on('error', function(e)
				{
					if (e.code == 'EADDRINUSE')
					{
						console.log('mavlink_port address in use, retrying...');
						setTimeout(function()
						{
							rover.mavlink_port.server.close();
							rover.mavlink_port.server.listen(rover.mavlink_port.port, rover.mavlink_port.ip_address);
						}, 1000);
					}
				});

				rover.mavlink_port.server.listen(rover.mavlink_port.port, rover.mavlink_port.ip_address);
			}
		}
	};


module.exports = create_mavlink_server;