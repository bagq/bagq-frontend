const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

/*
==============================
ADMIN ACCOUNT (CHANGE THIS!)
==============================
*/
const ADMIN_USER = "admin";

// Change password here
const ADMIN_PASS_HASH = bcrypt.hashSync("admin123", 10);

/*
==============================
LOGIN ROUTE
==============================
*/
app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                message: "Missing username or password"
            });
        }

        if (username !== ADMIN_USER) {
            return res.status(401).json({
                message: "Invalid username or password"
            });
        }

        const match = await bcrypt.compare(password, ADMIN_PASS_HASH);

        if (!match) {
            return res.status(401).json({
                message: "Invalid username or password"
            });
        }

        res.json({
            user: {
                username: ADMIN_USER,
                role: "admin"
            }
        });

    } catch (err) {
        res.status(500).json({
            message: "Server error"
        });
    }
});

/*
==============================
SOCKET TRACKING (YOUR ORIGINAL CODE)
==============================
*/

let devices = {};

io.on('connection', (socket) => {
    console.log('Device connected:', socket.id);

    socket.on('location-update', (data) => {
        devices[socket.id] = data;
        io.emit('new-location', data);
    });

    socket.on('disconnect', () => {
        console.log('Device disconnected');
        delete devices[socket.id];
    });
});

/*
==============================
SERVER START
==============================
*/

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
