const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve your HTML files
app.use(express.static(__dirname));

// Store connected devices
let devices = {};

io.on('connection', (socket) => {
    console.log('Device connected:', socket.id);

    // When a phone sends location
    socket.on('location-update', (data) => {
        devices[socket.id] = data;
        // Send to tracker
        io.emit('new-location', data);
    });

    socket.on('disconnect', () => {
        console.log('Device disconnected');
        delete devices[socket.id];
    });
});

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});