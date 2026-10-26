// WebRTC peer connection configuration with public STUN servers
// STUN helps discover public IP for NAT traversal
// TURN servers may be needed for restrictive networks (not configured here)
const iceServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

/**
 * Creates and configures an RTCPeerConnection
 * @param {MediaStream} localStream - The local media stream to add to the connection
 * @param {Function} onIceCandidate - Callback when an ICE candidate is generated
 * @param {Function} onTrack - Callback when a remote track is received
 * @param {Function} onConnectionStateChange - Callback when connection state changes
 * @returns {RTCPeerConnection} The configured peer connection
 */
export function createPeerConnection(
  localStream,
  onIceCandidate,
  onTrack,
  onConnectionStateChange
) {
  const peerConnection = new RTCPeerConnection(iceServers);

  // Add local stream tracks to the peer connection
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Handle ICE candidate generation
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      onIceCandidate(event.candidate);
    }
  };

  // Handle incoming remote stream
  peerConnection.ontrack = (event) => {
    console.log("[WebRTC] ontrack fired, streams:", event.streams.length);
    if (event.streams[0]) {
      console.log("[WebRTC] Remote stream tracks:", event.streams[0].getTracks().length);
    }
    onTrack(event.streams[0]);
  };

  // Handle connection state changes
  peerConnection.onconnectionstatechange = () => {
    console.log("[WebRTC] Connection state changed:", peerConnection.connectionState);
    onConnectionStateChange(peerConnection.connectionState);
  };

  // Handle ICE connection state changes
  peerConnection.oniceconnectionstatechange = () => {
    console.log("[WebRTC] ICE connection state changed:", peerConnection.iceConnectionState);
    onConnectionStateChange(peerConnection.iceConnectionState);
  };

  return peerConnection;
}

/**
 * Creates an offer for the peer connection
 * @param {RTCPeerConnection} peerConnection - The peer connection to create an offer for
 * @returns {Promise<RTCSessionDescriptionInit>} The session description
 */
export async function createOffer(peerConnection) {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  return offer;
}

/**
 * Creates an answer for the peer connection
 * @param {RTCPeerConnection} peerConnection - The peer connection to create an answer for
 * @param {RTCSessionDescriptionInit} offer - The remote offer to answer
 * @returns {Promise<RTCSessionDescriptionInit>} The session description
 */
export async function createAnswer(peerConnection, offer) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  return answer;
}

/**
 * Sets the remote description on the peer connection
 * @param {RTCPeerConnection} peerConnection - The peer connection
 * @param {RTCSessionDescriptionInit} description - The remote description
 */
export async function setRemoteDescription(peerConnection, description) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
}

/**
 * Adds an ICE candidate to the peer connection
 * @param {RTCPeerConnection} peerConnection - The peer connection
 * @param {RTCIceCandidateInit} candidate - The ICE candidate to add
 */
export function addIceCandidate(peerConnection, candidate) {
  peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

/**
 * Closes the peer connection and cleans up resources
 * @param {RTCPeerConnection} peerConnection - The peer connection to close
 */
export function closePeerConnection(peerConnection) {
  if (peerConnection) {
    peerConnection.close();
  }
}
