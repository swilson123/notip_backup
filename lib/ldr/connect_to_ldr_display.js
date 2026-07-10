// Launches the live LDR point-cloud viewer when white_rabbit.ldr.display_enabled is set:
// a WebSocket server broadcasts scan snapshots (built by ldr_edge_data.js), and a browser
// window is spawned in kiosk mode pointed at ldr_display.html to render them.

const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');

var connect_to_ldr_display = function (white_rabbit) {

    if (!white_rabbit.ldr.display_enabled || white_rabbit.ldr.display_server) return;

    white_rabbit.ldr.display_server = new WebSocket.Server({ port: white_rabbit.ldr.display_port });

    white_rabbit.ldr.display_server.on('connection', function (ws) {
        if (white_rabbit.ldr.display_last_payload) {
            ws.send(white_rabbit.ldr.display_last_payload);
        }
    });

    white_rabbit.ldr.display_server.on('error', function (e) {
        white_rabbit.logs.ldr_message_handler.log(white_rabbit, 'display server error: ' + e.message);
    });

    const html_url = 'file://' + path.resolve(__dirname, 'ldr_display.html') + '?port=' + white_rabbit.ldr.display_port;

    white_rabbit.ldr.display_process = spawn(white_rabbit.ldr.display_browser_path, ['--kiosk', '--incognito', html_url], {
        stdio: 'ignore'
    });

    white_rabbit.ldr.display_process.on('error', function (e) {
        white_rabbit.logs.ldr_message_handler.log(white_rabbit, 'display browser launch failed: ' + e.message);
    });

    white_rabbit.logs.ldr_message_handler.log(white_rabbit, 'ldr display started on port ' + white_rabbit.ldr.display_port);

};

module.exports = connect_to_ldr_display;
