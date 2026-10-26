const socket = require("socket.io");
const registerRoomHandlers = require("./room.handler");
const registerWebRTCHandlers = require("./webrtc.handler");


const registerSocketHandlers = (io) => {
    io.on("connection", (socket) => {
        console.log("Client connected:", socket.id);

        registerRoomHandlers(io, socket);
        registerWebRTCHandlers(io, socket);

        socket.on("disconnect", () => {
            console.log("Client disconnected:", socket.id);
        });
    });
};


const initializeSocket = (server) => {
    const io = socket(server, {
        cors: {
            origin: process.env.FRONTEND_URL || "http://localhost:5173",
            methods: ["GET", "POST"],
        },
    })
    registerSocketHandlers(io);

    return io
}


module.exports = initializeSocket