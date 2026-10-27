"use strict";

const logger = require("./logger");

// ── Safe metadata helpers ─────────────────────────────────────────────────────

/**
 * Extract non-sensitive structural metadata from an SDP description object.
 * The raw SDP string is never included in the returned object.
 */
const descriptionMeta = (desc) => {
  if (!desc || typeof desc !== "object") return { present: false };

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
 * Extract non-sensitive metadata from an ICE candidate object.
 * The full candidate string is never included in the returned object.
 *
 * Parsed fields (positions in the candidate SDP attribute line):
 *   index 0 – foundation   (omitted)
 *   index 1 – component    "1" = RTP, "2" = RTCP
 *   index 2 – protocol     "udp" | "tcp"
 *   index 3 – priority     (omitted)
 *   index 4 – ip           (omitted – could be a private address)
 *   index 5 – port         (omitted)
 *   index 6 – literal "typ"
 *   index 7 – candidateType "host" | "srflx" | "prflx" | "relay"
 */
const candidateMeta = (candidate) => {
  if (!candidate || typeof candidate !== "object") return { present: false };

  let protocol = null;
  let component = null;
  let candidateType = null;

  if (typeof candidate.candidate === "string" && candidate.candidate.length > 0) {
    const parts = candidate.candidate.split(" ");
    component = parts[1] ?? null;
    protocol = parts[2] ?? null;
    candidateType = parts[7] ?? null;
  }

  return {
    present: true,
    sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid : null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    protocol,
    component,
    candidateType, // "host" | "srflx" | "relay" – most useful for diagnosing NAT issues
  };
};

/**
 * Resolve the socket IDs that will receive a room broadcast,
 * i.e. every socket in the room except the sender.
 *
 * Returns { recipientIds: string[], recipientCount: number }
 *
 * Socket.IO's socket.to(roomId).emit() is fire-and-forget; this helper lets
 * us record *intended* recipients before the emit so the log is meaningful
 * even though we cannot confirm delivery at the transport layer.
 */
const resolveRecipients = (io, roomId, senderSocketId) => {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return { recipientIds: [], recipientCount: 0 };

  const recipientIds = [...room].filter((id) => id !== senderSocketId);
  return { recipientIds, recipientCount: recipientIds.length };
};

/**
 * Disconnect reasons from which Socket.IO automatically reconnects.
 * See: https://socket.io/docs/v4/client-api/#event-disconnect
 */
const RECONNECTABLE_REASONS = new Set([
  "io server disconnect",  // server called socket.disconnect() – client will NOT auto-reconnect
  "ping timeout",
  "transport close",
  "transport error",
]);

// Exported so socket.js can use the same classification.
const willReconnect = (reason) =>
  reason !== "io server disconnect" && reason !== "io client disconnect";

// ── Handler registration ──────────────────────────────────────────────────────

const registerWebRTCHandlers = (io, socket) => {

  // ── webrtc-offer ──────────────────────────────────────────────────────────
  socket.on("webrtc-offer", ({ roomId, offer } = {}) => {

    // Validate: roomId present
    if (!roomId) {
      logger.warn("webrtc-offer dropped: missing roomId", {
        event: "webrtc-offer",
        senderSocketId: socket.id,
        dropReason: "missing_room_id",
      });
      return;
    }

    // Validate: payload present
    if (!offer) {
      logger.warn("webrtc-offer dropped: missing offer payload", {
        event: "webrtc-offer",
        senderSocketId: socket.id,
        roomId,
        dropReason: "missing_offer_payload",
      });
      return;
    }

    // Validate: sender is authorised (must be in the room)
    if (!socket.rooms.has(roomId)) {
      logger.warn("webrtc-offer dropped: sender not in room", {
        event: "webrtc-offer",
        senderSocketId: socket.id,
        roomId,
        dropReason: "sender_not_in_room",
      });
      return;
    }

    const { recipientIds, recipientCount } = resolveRecipients(io, roomId, socket.id);

    if (recipientCount === 0) {
      logger.warn("webrtc-offer dropped: no recipients in room", {
        event: "webrtc-offer",
        senderSocketId: socket.id,
        roomId,
        dropReason: "no_recipients",
        offer: descriptionMeta(offer),
      });
      return;
    }

    logger.info("webrtc-offer forwarded", {
      event: "webrtc-offer",
      senderSocketId: socket.id,
      roomId,
      recipientIds,       // socket ID(s) that will receive the event
      recipientCount,
      offer: descriptionMeta(offer),
      // Note: socket.to().emit() is fire-and-forget; this log confirms the
      // emit was attempted, not that the remote browser received or applied it.
      forwardAttempted: true,
    });

    socket.to(roomId).emit("webrtc-offer", {
      offer,
      socketId: socket.id,
    });
  });

  // ── webrtc-answer ─────────────────────────────────────────────────────────
  socket.on("webrtc-answer", ({ roomId, answer } = {}) => {

    if (!roomId) {
      logger.warn("webrtc-answer dropped: missing roomId", {
        event: "webrtc-answer",
        senderSocketId: socket.id,
        dropReason: "missing_room_id",
      });
      return;
    }

    if (!answer) {
      logger.warn("webrtc-answer dropped: missing answer payload", {
        event: "webrtc-answer",
        senderSocketId: socket.id,
        roomId,
        dropReason: "missing_answer_payload",
      });
      return;
    }

    if (!socket.rooms.has(roomId)) {
      logger.warn("webrtc-answer dropped: sender not in room", {
        event: "webrtc-answer",
        senderSocketId: socket.id,
        roomId,
        dropReason: "sender_not_in_room",
      });
      return;
    }

    const { recipientIds, recipientCount } = resolveRecipients(io, roomId, socket.id);

    if (recipientCount === 0) {
      logger.warn("webrtc-answer dropped: no recipients in room", {
        event: "webrtc-answer",
        senderSocketId: socket.id,
        roomId,
        dropReason: "no_recipients",
        answer: descriptionMeta(answer),
      });
      return;
    }

    logger.info("webrtc-answer forwarded", {
      event: "webrtc-answer",
      senderSocketId: socket.id,
      roomId,
      recipientIds,
      recipientCount,
      answer: descriptionMeta(answer),
      forwardAttempted: true,
    });

    socket.to(roomId).emit("webrtc-answer", {
      answer,
      socketId: socket.id,
    });
  });

  // ── webrtc-ice-candidate ──────────────────────────────────────────────────
  socket.on("webrtc-ice-candidate", ({ roomId, candidate } = {}) => {

    if (!roomId) {
      logger.warn("webrtc-ice-candidate dropped: missing roomId", {
        event: "webrtc-ice-candidate",
        senderSocketId: socket.id,
        dropReason: "missing_room_id",
      });
      return;
    }

    if (!candidate) {
      logger.warn("webrtc-ice-candidate dropped: missing candidate payload", {
        event: "webrtc-ice-candidate",
        senderSocketId: socket.id,
        roomId,
        dropReason: "missing_candidate_payload",
      });
      return;
    }

    if (!socket.rooms.has(roomId)) {
      logger.warn("webrtc-ice-candidate dropped: sender not in room", {
        event: "webrtc-ice-candidate",
        senderSocketId: socket.id,
        roomId,
        dropReason: "sender_not_in_room",
        candidate: candidateMeta(candidate),
      });
      return;
    }

    const { recipientIds, recipientCount } = resolveRecipients(io, roomId, socket.id);

    if (recipientCount === 0) {
      // This can happen during teardown; warn so it's visible without being noisy.
      logger.warn("webrtc-ice-candidate dropped: no recipients in room", {
        event: "webrtc-ice-candidate",
        senderSocketId: socket.id,
        roomId,
        dropReason: "no_recipients",
        candidate: candidateMeta(candidate),
      });
      return;
    }

    // TODO: restore to logger.debug after NAT/ICE diagnosis is complete.
    // Temporarily promoted to info so candidates are visible at LOG_LEVEL=info
    // on Render. candidateType ("host"|"srflx"|"relay") is the key NAT diagnostic.
    logger.info("webrtc-ice-candidate forwarded", {
      event: "webrtc-ice-candidate",
      senderSocketId: socket.id,
      roomId,
      recipientIds,
      recipientCount,
      candidate: candidateMeta(candidate),
      forwardAttempted: true,
    });

    socket.to(roomId).emit("webrtc-ice-candidate", {
      candidate,
      socketId: socket.id,
    });
  });
};

module.exports = registerWebRTCHandlers;
