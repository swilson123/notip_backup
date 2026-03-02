//From Terminal navigate to this folder and run: node server.js
//This code should be installed on truck and drone............

process.on('uncaughtException', function (err) {
	console.error('Process Caught exception: ', err);
});

process.on('error', function (err) {
	console.error('process error', err);
});

process.on('exit', function (err) {
	console.error('process exit', err);
});

const notip_init = require('./lib/notip.js');


//Fetch setup params......................
var fs = require('fs');
var data = fs.readFileSync('./setup.json');
var setup = null;

try {
	setup = JSON.parse(data);

	notip_init(setup);
} catch (err) {
	console.log('There has been an error parsing the setup JSON.');
	console.log(err);
}