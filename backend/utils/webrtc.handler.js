const registerWebRTCHandlers = (io, socket) => {
    // Forward a WebRTC offer to the other participant
    socket.on("webrtc-offer", ({ roomId, offer }) => {
        if (!roomId || !offer || !socket.rooms.has(roomId)) {
            return;
        }

        socket.to(roomId).emit("webrtc-offer", {
            offer,
            socketId: socket.id,
        });
    });

    // Forward a WebRTC answer to the other participant
    socket.on("webrtc-answer", ({ roomId, answer }) => {
        if (!roomId || !answer || !socket.rooms.has(roomId)) {
            return;
        }

        socket.to(roomId).emit("webrtc-answer", {
            answer,
            socketId: socket.id,
        });
    });

    // Forward ICE candidates to the other participant
    socket.on("webrtc-ice-candidate", ({ roomId, candidate }) => {
        if (!roomId || !candidate || !socket.rooms.has(roomId)) {
            return;
        }

        socket.to(roomId).emit("webrtc-ice-candidate", {
            candidate,
            socketId: socket.id,
        });
    });
};

module.exports = registerWebRTCHandlers;
