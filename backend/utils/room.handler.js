"use strict";

const { randomUUID } = require("crypto");
const logger = require("./logger");

const registerRoomHandlers = (io, socket) => {
  // ── Internal helper: leave a room and notify the remaining participant ────
  const leaveRoom = async (roomId) => {
    if (!roomId || !socket.rooms.has(roomId)) {
      logger.debug("leaveRoom: socket not in room, skipping", {
        socketId: socket.id,
        roomId,
      });
      return;
    }

    await socket.leave(roomId);

    socket.to(roomId).emit("user-left", {
      socketId: socket.id,
      roomId,
    });

    logger.info("Participant left room", {
      socketId: socket.id,
      roomId,
    });
  };

  // ── create-room ───────────────────────────────────────────────────────────
  socket.on("create-room", async (callback) => {
    logger.debug("Room creation requested", { socketId: socket.id });

    try {
      const roomId = randomUUID();

      await socket.join(roomId);

      logger.info("Room created", {
        socketId: socket.id,
        roomId,
      });

      callback?.({
        success: true,
        message: "Room created successfully",
        roomId,
      });
    } catch (err) {
      logger.error("Failed to create room", {
        socketId: socket.id,
        error: err.message,
        stack: err.stack,
      });

      callback?.({
        success: false,
        message: "Failed to create room",
      });
    }
  });

  // ── join-room ─────────────────────────────────────────────────────────────
  socket.on("join-room", async (roomId, callback) => {
    // Validate input
    if (typeof roomId !== "string" || !roomId.trim()) {
      logger.warn("join-room: invalid room ID supplied", {
        socketId: socket.id,
        roomId,
      });
      return callback?.({
        success: false,
        message: "Valid room ID is required",
      });
    }

    roomId = roomId.trim();

    logger.debug("Room join requested", { socketId: socket.id, roomId });

    try {
      const room = io.sockets.adapter.rooms.get(roomId);

      // Room does not exist
      if (!room) {
        logger.warn("join-room: room not found", {
          socketId: socket.id,
          roomId,
        });
        return callback?.({
          success: false,
          message: "Room not found",
        });
      }

      // Room is already at capacity
      if (room.size >= 2) {
        logger.warn("join-room: room is full", {
          socketId: socket.id,
          roomId,
          currentSize: room.size,
        });
        return callback?.({
          success: false,
          message: "Room is full",
        });
      }

      // Already in this room — idempotent response
      if (socket.rooms.has(roomId)) {
        logger.debug("join-room: already in room", {
          socketId: socket.id,
          roomId,
        });
        return callback?.({
          success: true,
          message: "Already in this room",
          roomId,
        });
      }

      const sizeBeforeJoin = room.size;

      await socket.join(roomId);

      const sizeAfterJoin =
        io.sockets.adapter.rooms.get(roomId)?.size ?? sizeBeforeJoin + 1;

      logger.info("Participant joined room", {
        socketId: socket.id,
        roomId,
        participantsBefore: sizeBeforeJoin,
        participantsAfter: sizeAfterJoin,
      });

      callback?.({
        success: true,
        message: "Joined room successfully",
        roomId,
      });

      // Notify the other participant
      socket.to(roomId).emit("user-joined", {
        socketId: socket.id,
        roomId,
      });
    } catch (err) {
      logger.error("Failed to join room", {
        socketId: socket.id,
        roomId,
        error: err.message,
        stack: err.stack,
      });

      callback?.({
        success: false,
        message: "Failed to join room",
      });
    }
  });

  // ── leave-room ────────────────────────────────────────────────────────────
  socket.on("leave-room", async (roomId, callback) => {
    if (typeof roomId !== "string" || !roomId.trim()) {
      logger.warn("leave-room: invalid room ID supplied", {
        socketId: socket.id,
        roomId,
      });
      return callback?.({
        success: false,
        message: "Valid room ID is required",
      });
    }

    try {
      await leaveRoom(roomId.trim());

      callback?.({
        success: true,
        message: "Left room successfully",
      });
    } catch (err) {
      logger.error("Failed to leave room", {
        socketId: socket.id,
        roomId,
        error: err.message,
        stack: err.stack,
      });

      callback?.({
        success: false,
        message: "Failed to leave room",
      });
    }
  });

  // ── disconnecting ─────────────────────────────────────────────────────────
  // Fires before the socket is actually removed from rooms, so we can still
  // identify which rooms the socket belonged to.
  socket.on("disconnecting", () => {
    const sharedRooms = [...socket.rooms].filter((r) => r !== socket.id);

    if (sharedRooms.length === 0) {
      logger.debug("disconnecting: socket had no shared rooms", {
        socketId: socket.id,
      });
      return;
    }

    logger.info("Participant disconnecting, notifying rooms", {
      socketId: socket.id,
      rooms: sharedRooms,
    });

    for (const roomId of sharedRooms) {
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        roomId,
      });
    }
  });
};

module.exports = registerRoomHandlers;
