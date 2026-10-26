
const { randomUUID } = require("crypto");

const registerRoomHandlers = (io, socket) => {
    // Notify the other participant and remove this socket from a room
    const leaveRoom = async (roomId) => {
        if (!roomId || !socket.rooms.has(roomId)) {
            return;
        }

        await socket.leave(roomId);

        socket.to(roomId).emit("user-left", {
            socketId: socket.id,
            roomId,
        });

        console.log(`${socket.id} left room ${roomId}`);
    };

    // Create a new room
    socket.on("create-room", async (callback) => {
        const roomId = randomUUID();

        await socket.join(roomId);

        console.log(`${socket.id} created room ${roomId}`);

        callback?.({
            success: true,
            message: "Room created successfully",
            roomId,
        });
    });

    // Join an existing room
    socket.on("join-room", async (roomId, callback) => {
        if (typeof roomId !== "string" || !roomId.trim()) {
            return callback?.({
                success: false,
                message: "Valid room ID is required",
            });
        }

        roomId = roomId.trim();

        const room = io.sockets.adapter.rooms.get(roomId);

        if (!room) {
            return callback?.({
                success: false,
                message: "Room not found",
            });
        }

        // Prevent joining a room that already has two participants
        if (room.size >= 2) {
            return callback?.({
                success: false,
                message: "Room is full",
            });
        }

        // Avoid duplicate join notifications if already in this room
        if (socket.rooms.has(roomId)) {
            return callback?.({
                success: true,
                message: "Already in this room",
                roomId,
            });
        }

        await socket.join(roomId);

        console.log(`${socket.id} joined room ${roomId}`);

        callback?.({
            success: true,
            message: "Joined room successfully",
            roomId,
        });

        socket.to(roomId).emit("user-joined", {
            socketId: socket.id,
            roomId,
        });
    });

    // Explicitly leave a room
    socket.on("leave-room", async (roomId, callback) => {
        if (typeof roomId !== "string" || !roomId.trim()) {
            return callback?.({
                success: false,
                message: "Valid room ID is required",
            });
        }

        await leaveRoom(roomId.trim());

        callback?.({
            success: true,
            message: "Left room successfully",
        });
    });

    // Notify other participants when this socket disconnects
    socket.on("disconnecting", () => {
        for (const roomId of socket.rooms) {
            // Each socket automatically belongs to a private room named socket.id
            if (roomId !== socket.id) {
                socket.to(roomId).emit("user-left", {
                    socketId: socket.id,
                    roomId,
                });
            }
        }
    });
};

module.exports = registerRoomHandlers;
