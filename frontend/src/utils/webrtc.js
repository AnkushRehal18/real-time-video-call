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
    const urls = turnUrls.split(',').map(url => url.trim());
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
 * @returns {RTCPeerConnection}
 */
export function createPeerConnection(
  localStream,
  onIceCandidate,
  onTrack,
  onConnectionStateChange
) {
  const peerConnection = new RTCPeerConnection(getIceServers());

  // Add local stream tracks so the remote peer can receive our media.
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  } else {
    // No local stream: add recvonly transceivers so the SDP includes the
    // correct media sections and we can still receive remote tracks.
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    peerConnection.addTransceiver("audio", { direction: "recvonly" });
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      onIceCandidate(event.candidate);
    }
  };

  // Use a single MediaStream for all incoming tracks so that replacing
  // srcObject on the second ontrack event does not discard the first track.
  // Both audio and video tracks end up in the same stream.
  const remoteStream = new MediaStream();
  peerConnection.ontrack = (event) => {
    // Prefer the stream provided by the browser; fall back to the shared one.
    if (event.streams && event.streams.length > 0) {
      // The browser already groups both tracks into one stream. Notify the
      // caller every time a new track arrives so the video element is
      // (re-)assigned the stream containing the most up-to-date track list.
      onTrack(event.streams[0]);
    } else {
      remoteStream.addTrack(event.track);
      onTrack(remoteStream);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    onConnectionStateChange(peerConnection.connectionState);
  };

  peerConnection.oniceconnectionstatechange = () => {
    onConnectionStateChange(peerConnection.iceConnectionState);
  };

  return peerConnection;
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
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  return answer;
}

/**
 * Sets the remote description on the peer connection.
 *
 * @param {RTCPeerConnection} peerConnection
 * @param {RTCSessionDescriptionInit} description
 */
export async function setRemoteDescription(peerConnection, description) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
}

/**
 * Adds an ICE candidate to the peer connection.
 * Returns a promise so callers can handle errors.
 *
 * @param {RTCPeerConnection} peerConnection
 * @param {RTCIceCandidateInit} candidate
 * @returns {Promise<void>}
 */
export function addIceCandidate(peerConnection, candidate) {
  return peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
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
