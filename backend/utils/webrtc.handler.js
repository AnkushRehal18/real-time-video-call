"use strict";

const logger = require("./logger");

/**
 * Safe metadata extractor for an SDP description object.
 * Returns only non-sensitive structural info; never logs the raw SDP string.
 */
const descriptionMeta = (desc) => {
  if (!desc || typeof desc !== "object") return { present: false };

  // Count media sections (m= lines) without retaining the SDP text
  let mediaSections = 0;
  if (typeof desc.sdp === "string") {
    mediaSections = (desc.sdp.match(/^m=/gm) || []).length;
  }

  return {
    present: true,
    type: typeof desc.type === "string" ? desc.type : "unknown",
    mediaSections,
  };
};

/**
 * Safe metadata extractor for an ICE candidate.
 * Logs only whether a candidate is present and its protocol/component
 * hints, never the full candidate string.
 */
const candidateMeta = (candidate) => {
  if (!candidate || typeof candidate !== "object") return { present: false };

  // Extract non-sensitive hints from the candidate string if available
  let protocol = null;
  let component = null;
  let candidateType = null;

  if (typeof candidate.candidate === "string") {
    const parts = candidate.candidate.split(" ");
    // candidate string format: foundation component protocol priority ip port type ...
    component = parts[1] ?? null;   // "1" (RTP) or "2" (RTCP)
    protocol = parts[2] ?? null;    // "udp" | "tcp"
    candidateType = parts[7] ?? null; // "host" | "srflx" | "relay"
  }

  return {
    present: true,
    sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid : null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    protocol,
    component,
    candidateType,
  };
};

const registerWebRTCHandlers = (io, socket) => {
  // ── webrtc-offer ──────────────────────────────────────────────────────────
  socket.on("webrtc-offer", ({ roomId, offer } = {}) => {
    const meta = {
      event: "webrtc-offer",
      senderSocketId: socket.id,
      roomId: roomId ?? null,
      offer: descriptionMeta(offer),
    };

    if (!roomId) {
      logger.warn("webrtc-offer: missing roomId, dropping", meta);
      return;
    }

    if (!offer) {
      logger.warn("webrtc-offer: missing offer payload, dropping", meta);
      return;
    }

    if (!socket.rooms.has(roomId)) {
      logger.warn("webrtc-offer: sender not in room, dropping", meta);
      return;
    }

    logger.info("webrtc-offer: forwarding to room", meta);

    socket.to(roomId).emit("webrtc-offer", {
      offer,
      socketId: socket.id,
    });

    logger.debug("webrtc-offer: forwarded", meta);
  });

  // ── webrtc-answer ─────────────────────────────────────────────────────────
  socket.on("webrtc-answer", ({ roomId, answer } = {}) => {
    const meta = {
      event: "webrtc-answer",
      senderSocketId: socket.id,
      roomId: roomId ?? null,
      answer: descriptionMeta(answer),
    };

    if (!roomId) {
      logger.warn("webrtc-answer: missing roomId, dropping", meta);
      return;
    }

    if (!answer) {
      logger.warn("webrtc-answer: missing answer payload, dropping", meta);
      return;
    }

    if (!socket.rooms.has(roomId)) {
      logger.warn("webrtc-answer: sender not in room, dropping", meta);
      return;
    }

    logger.info("webrtc-answer: forwarding to room", meta);

    socket.to(roomId).emit("webrtc-answer", {
      answer,
      socketId: socket.id,
    });

    logger.debug("webrtc-answer: forwarded", meta);
  });

  // ── webrtc-ice-candidate ──────────────────────────────────────────────────
  socket.on("webrtc-ice-candidate", ({ roomId, candidate } = {}) => {
    const meta = {
      event: "webrtc-ice-candidate",
      senderSocketId: socket.id,
      roomId: roomId ?? null,
      candidate: candidateMeta(candidate),
    };

    if (!roomId) {
      logger.warn("webrtc-ice-candidate: missing roomId, dropping", meta);
      return;
    }

    if (!candidate) {
      logger.warn(
        "webrtc-ice-candidate: missing candidate payload, dropping",
        meta
      );
      return;
    }

    if (!socket.rooms.has(roomId)) {
      logger.warn(
        "webrtc-ice-candidate: sender not in room, dropping",
        meta
      );
      return;
    }

    logger.debug("webrtc-ice-candidate: forwarding", meta);

    socket.to(roomId).emit("webrtc-ice-candidate", {
      candidate,
      socketId: socket.id,
    });
  });
};

module.exports = registerWebRTCHandlers;
