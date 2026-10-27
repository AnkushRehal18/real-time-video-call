// WebRTC peer connection configuration with public STUN servers
// STUN helps discover public IP for NAT traversal
// TURN servers may be needed for restrictive networks (configured via environment)
function getIceServers() {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // Add TURN server if configured
  const turnUrls = import.meta.env.VITE_TURN_URLS;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUrls && turnUsername && turnCredential) {
    const urls = turnUrls.split(",").map((url) => url.trim());
    iceServers.push({
      urls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return { iceServers };
}

/**
 * Creates and configures an RTCPeerConnection.
 *
 * @param {MediaStream|null} localStream - Local media stream to add to the connection.
 * @param {Function} onIceCandidate - Called when an ICE candidate is generated.
 * @param {Function} onTrack - Called with the remote MediaStream when tracks arrive.
 * @param {Function} onConnectionStateChange - Called when connection/ICE state changes.
 * @param {string} role - "offerer" or "answerer", used only for diagnostic logging.
 * @returns {RTCPeerConnection}
 */
export function createPeerConnection(
  localStream,
  onIceCandidate,
  onTrack,
  onConnectionStateChange,
  role = "unknown"
) {
  const pc = new RTCPeerConnection(getIceServers());

  // ── DIAGNOSTIC: log what tracks are being added ──────────────────────────
  if (localStream) {
    const tracks = localStream.getTracks();
    console.log(
      `[WebRTC][${role}] createPeerConnection: adding ${tracks.length} local track(s):`,
      tracks.map((t) => `${t.kind} enabled=${t.enabled} readyState=${t.readyState}`)
    );
    tracks.forEach((track) => {
      pc.addTrack(track, localStream);
    });
  } else {
    // No local stream: add recvonly transceivers so the SDP includes the
    // correct media sections and we can still receive remote tracks.
    console.warn(
      `[WebRTC][${role}] createPeerConnection: NO local stream — adding recvonly transceivers. ` +
        "Remote side will NOT send media back to this peer."
    );
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      // Log safe metadata only — never the full candidate string
      const c = event.candidate;
      const parts =
        typeof c.candidate === "string" ? c.candidate.split(" ") : [];
      console.log(`[WebRTC][${role}] ICE candidate generated:`, {
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        protocol: parts[2] ?? null,
        candidateType: parts[7] ?? null,
      });
      onIceCandidate(c);
    } else {
      console.log(`[WebRTC][${role}] ICE gathering complete (null candidate)`);
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log(
      `[WebRTC][${role}] iceGatheringState →`,
      pc.iceGatheringState
    );
  };

  // Use a single MediaStream for all incoming tracks so that replacing
  // srcObject on the second ontrack event does not discard the first track.
  // Both audio and video tracks end up in the same stream.
  const remoteStream = new MediaStream();
  pc.ontrack = (event) => {
    // ── DIAGNOSTIC: confirm ontrack fires and what it carries ─────────────
    const track = event.track;
    const streamIds = event.streams.map((s) => s.id);
    console.log(`[WebRTC][${role}] ontrack fired:`, {
      kind: track.kind,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
      streamCount: event.streams.length,
      streamIds,
    });

    if (event.streams && event.streams.length > 0) {
      const stream = event.streams[0];
      console.log(`[WebRTC][${role}] ontrack: assigning remote stream`, {
        streamId: stream.id,
        videoTracks: stream.getVideoTracks().length,
        audioTracks: stream.getAudioTracks().length,
      });
      onTrack(stream);
    } else {
      remoteStream.addTrack(track);
      console.log(`[WebRTC][${role}] ontrack: added track to shared remoteStream`, {
        videoTracks: remoteStream.getVideoTracks().length,
        audioTracks: remoteStream.getAudioTracks().length,
      });
      onTrack(remoteStream);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(
      `[WebRTC][${role}] connectionState →`,
      pc.connectionState
    );
    onConnectionStateChange(pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(
      `[WebRTC][${role}] iceConnectionState →`,
      pc.iceConnectionState
    );
    // Only propagate states that map directly to RTCPeerConnection.connectionState
    // values, so the UI state machine stays consistent. iceConnectionState
    // "checking" and "completed" are intentionally not forwarded.
    const ice = pc.iceConnectionState;
    if (ice === "failed" || ice === "disconnected" || ice === "closed") {
      onConnectionStateChange(ice);
    }
  };

  pc.onsignalingstatechange = () => {
    console.log(
      `[WebRTC][${role}] signalingState →`,
      pc.signalingState
    );
  };

  return pc;
}

/**
 * Creates an offer and sets it as the local description.
 *
 * @param {RTCPeerConnection} peerConnection
 * @returns {Promise<RTCSessionDescriptionInit>}
 */
export async function createOffer(peerConnection) {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  // Log safe structural metadata only — never the SDP string
  console.log("[WebRTC][offerer] createOffer: local description set", {
    type: offer.type,
    mediaSections: (offer.sdp?.match(/^m=/gm) || []).length,
  });
  return offer;
}

/**
 * Applies a remote offer and creates an answer.
 * Sets both the remote and local descriptions.
 *
 * @param {RTCPeerConnection} peerConnection
 * @param {RTCSessionDescriptionInit} offer
 * @returns {Promise<RTCSessionDescriptionInit>}
 */
export async function createAnswer(peerConnection, offer) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  console.log("[WebRTC][answerer] createAnswer: remote description (offer) set", {
    type: offer.type,
    mediaSections: (offer.sdp?.match(/^m=/gm) || []).length,
  });
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  console.log("[WebRTC][answerer] createAnswer: local description (answer) set", {
    type: answer.type,
    mediaSections: (answer.sdp?.match(/^m=/gm) || []).length,
  });
  return answer;
}

/**
 * Sets the remote description on the peer connection.
 *
 * @param {RTCPeerConnection} peerConnection
 * @param {RTCSessionDescriptionInit} description
 */
export async function setRemoteDescription(peerConnection, description) {
  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(description)
  );
  console.log("[WebRTC][offerer] setRemoteDescription: remote description (answer) set", {
    type: description.type,
    mediaSections: (description.sdp?.match(/^m=/gm) || []).length,
  });
}

/**
 * Adds an ICE candidate to the peer connection.
 * Returns a promise so callers can handle errors.
 *
 * @param {RTCPeerConnection} peerConnection
 * @param {RTCIceCandidateInit} candidate
 * @returns {Promise<void>}
 */
export async function addIceCandidate(peerConnection, candidate) {
  await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

/**
 * Closes the peer connection and cleans up resources.
 *
 * @param {RTCPeerConnection} peerConnection
 */
export function closePeerConnection(peerConnection) {
  if (peerConnection) {
    peerConnection.close();
  }
}
