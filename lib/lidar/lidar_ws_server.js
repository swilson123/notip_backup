// Simple WebSocket server to broadcast LIDAR data points to HTML visualization
// Place in lib/lidar/lidar_ws_server.js

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let latestPoints = [];

wss.on('connection', (ws) => {
  // Send latest points on connect
  ws.send(JSON.stringify(latestPoints));
});

// Export a function to update points from lidar_message_handler
module.exports = {
  update(points) {
    latestPoints = points;
    // Broadcast to all clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(latestPoints));
      }
    });
  }
};
