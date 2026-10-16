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

// Browser errors are sent here so they show up in the server logs (e.g. Railway's deploy logs).
let clientErrors = 0;
setInterval(() => { clientErrors = 0; }, 60_000).unref();
app.post('/api/client-error', express.text({ type: '*/*', limit: '8kb' }), (req, res) => {
  if (clientErrors++ < 50) console.warn('[client error]', String(req.body || '').slice(0, 2000));
  res.status(204).end();
});

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
  // Hosts like Railway send SIGTERM before replacing the container: stop cleanly.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`${sig} received, shutting down`);
      // io.close() disconnects every player and closes the HTTP server too.
      io.close(() => process.exit(0));
      server.closeAllConnections?.();
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = { app, server, io, rooms };
