"use strict";

const socketIO = require("socket.io");
const logger = require("./logger");
const registerRoomHandlers = require("./room.handler");
const registerWebRTCHandlers = require("./webrtc.handler");

/**
 * Classify a Socket.IO disconnect reason so the log clearly shows whether
 * the client is expected to attempt an automatic reconnect.
 *
 * Reasons where the client does NOT auto-reconnect:
 *   "io server disconnect"  – server explicitly called socket.disconnect()
 *   "io client disconnect"  – client explicitly called socket.disconnect()
 *
 * All other built-in reasons (ping timeout, transport close, transport error)
 * trigger the client's automatic reconnection logic.
 */
const disconnectMeta = (reason) => {
  const clientWillReconnect =
    reason !== "io server disconnect" && reason !== "io client disconnect";
  return { reason, clientWillReconnect };
};

// ── Per-connection event wiring ───────────────────────────────────────────────
const registerSocketHandlers = (io) => {
  io.on("connection", (socket) => {
    const transport = socket.conn?.transport?.name ?? "unknown";

    logger.info("Client connected", {
      socketId: socket.id,
      transport,
    });

    // Register domain-specific handlers
    registerRoomHandlers(io, socket);
    registerWebRTCHandlers(io, socket);

    // Wrap each handler registration in a try/catch so one bad handler
    // cannot bring down the entire connection.
    socket.on("error", (err) => {
      logger.error("Socket error", {
        socketId: socket.id,
        error: err.message,
        stack: err.stack,
      });
    });

    socket.on("disconnect", (reason) => {
      logger.info("Client disconnected", {
        socketId: socket.id,
        ...disconnectMeta(reason),
      });
    });

    socket.on("connect_error", (err) => {
      logger.warn("Socket connection error", {
        socketId: socket.id,
        error: err.message,
      });
    });
  });
};

// ── Socket.IO initialization ──────────────────────────────────────────────────
const initializeSocket = (server) => {
  const frontendUrl =
    process.env.FRONTEND_URL ||
    "https://real-time-video-call-nine.vercel.app";

  // Normalise: remove trailing slash
  const origin = frontendUrl.endsWith("/")
    ? frontendUrl.slice(0, -1)
    : frontendUrl;

  logger.debug("Configuring Socket.IO CORS", { origin });

  const io = socketIO(server, {
    cors: {
      origin,
      methods: ["GET", "POST"],
    },
  });

  registerSocketHandlers(io);

  return io;
};

module.exports = initializeSocket;
