//sends message to radio and websocket........................
var init_robotkit = function(rover)
	{
		if (!rover.sitl.robotkit && rover.mav_version == 1)
		{
			//Run this command from terminal: robotkit-sitl copter --home=39.28389,-84.3016354,584,353
			//robotkit-sitl ./lib/robotkit/arducopter --home=39.28389,-84.3016354,584,353
			var command = "robotkit-sitl copter --home=" + rover.sitl.lat + "," + rover.sitl.lon + ",584,353";
			//var command = "robotkit-sitl copter --home=" + rover.sitl.lat + "," + rover.sitl.lon + ",584,353";
			//Start python ready_to_localize script......................
			rover.sitl.robotkit = rover.exec(command, function(error, stdout, stderr)
			{
				if (error)
				{

					rover.logs.robotkit.log(rover, 'ERROR Dronekit:\n' + error);
					setTimeout(function()
					{
						rover.init_robotkit(rover);
					}, 1000);

					rover.sitl.robotkit = null;

				}

			});

			rover.sitl.robotkit.stdout.on('data', function(v)
			{
				rover.logs.robotkit.log(rover, v.toString());
			});

			rover.sitl.robotkit.stdout.on('error', function(e)
			{
				console.log('robotkit: ', e);
			});

		}
		else if (!rover.sitl.robotkit && rover.mav_version == 2)
		{
			rover.sitl.robotkit = true;
			console.log('mavlink 2 SITL Command: robotkit-sitl ./lib/robotkit/arducopter --home=39.28389,-84.3016354,584,353')

		}

	};


module.exports = init_robotkit;