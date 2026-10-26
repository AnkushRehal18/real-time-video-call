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
    const frontendUrl = process.env.FRONTEND_URL || "https://real-time-video-call-nine.vercel.app";
    // Remove trailing slash if present
    const origin = frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;
    
    const io = socket(server, {
        cors: {
            origin: origin,
            methods: ["GET", "POST"],
        },
    })
    registerSocketHandlers(io);

    return io
}


module.exports = initializeSocket