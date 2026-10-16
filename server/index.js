const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
// Three.js (3D kart rendering) served straight from node_modules.
app.use('/vendor/three', express.static(path.join(__dirname, '..', 'node_modules', 'three')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  // Telephone drawings are sent as PNG data URLs.
  maxHttpBufferSize: 2e6,
});

const rooms = new RoomManager(io);

io.on('connection', (socket) => {
  socket.on('room:create', (data, ack) => rooms.create(socket, data, ack));
  socket.on('room:join', (data, ack) => rooms.join(socket, data, ack));
  socket.on('disconnect', () => rooms.disconnect(socket));

  // Everything else is routed to the player's current room.
  socket.onAny((event, data, ack) => {
    if (event.startsWith('room:create') || event.startsWith('room:join')) return;
    rooms.route(socket, event, data, ack);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`TeamUp running on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io, rooms };
