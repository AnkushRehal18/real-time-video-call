
import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import { getMediaStream, stopMediaStream, getCameraLabel } from "../utils/media";
import {
  createPeerConnection,
  createOffer,
  createAnswer,
  setRemoteDescription,
  addIceCandidate,
  closePeerConnection,
} from "../utils/webrtc";
import "../App.css";

const SOCKET_URL = import.meta.env.VITE_BASE_URL;

function VideoScreen() {
  const [socket, setSocket] = useState(null);
  const [roomId, setRoomId] = useState("");
  const [message, setMessage] = useState("Connecting to server...");
  const [connected, setConnected] = useState(false);
  const [activeRoom, setActiveRoom] = useState("");
  const [participantJoined, setParticipantJoined] = useState(false);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [isInitiator, setIsInitiator] = useState(false);
  const [cameraLabel, setCameraLabel] = useState(getCameraLabel());
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const isRoomCreatorRef = useRef(false);
  const socketRef = useRef(null);
  const activeRoomRef = useRef(null);
  useEffect(() => {
    const newSocket = io(SOCKET_URL);

    newSocket.on("connect", () => {
      setConnected(true);
      setMessage("Connected to server. Create or join a room.");
    });

    newSocket.on("connect_error", (error) => {
      setMessage(`Connection failed: ${error.message}`);
    });

    newSocket.on("disconnect", () => {
      setConnected(false);
      setActiveRoom("");
      setParticipantJoined(false);
      setMessage("Disconnected from server.");
    });

    newSocket.on("user-joined", ({ socketId }) => {
      console.log("[VideoScreen] user-joined event received, socketId:", socketId);
      console.log("[VideoScreen] isRoomCreator:", isRoomCreatorRef.current, "activeRoom:", activeRoomRef.current);
      setParticipantJoined(true);
      setMessage(`Another user joined the room: ${socketId}`);
      
      // If we created the room, initiate the WebRTC call
      // Note: activeRoomRef.current might not be set yet due to React state batching
      // Use the activeRoom state directly instead
      if (isRoomCreatorRef.current) {
        console.log("[VideoScreen] Initiating WebRTC call as room creator");
        initiateWebRTCCall();
      } else {
        console.log("[VideoScreen] Not initiating call - isRoomCreator:", isRoomCreatorRef.current);
      }
    });

    newSocket.on("user-left", ({ socketId }) => {
      setParticipantJoined(false);
      setConnectionState("disconnected");
      setMessage(`Participant ${socketId} left the room.`);
      cleanupWebRTC();
    });

    // WebRTC signaling handlers
    newSocket.on("webrtc-offer", async ({ offer, socketId }) => {
      console.log("[VideoScreen] webrtc-offer received from:", socketId);
      if (!peerConnectionRef.current) {
        console.log("[VideoScreen] Creating peer connection for offer");
        setupPeerConnection();
      }
      try {
        await createAnswer(peerConnectionRef.current, offer);
        console.log("[VideoScreen] Answer created, sending to:", socketId);
        newSocket.emit("webrtc-answer", { roomId: activeRoomRef.current, answer: peerConnectionRef.current.localDescription });
        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");
      } catch (error) {
        console.error("Error creating answer:", error);
        setMessage("Failed to establish connection.");
      }
    });

    newSocket.on("webrtc-answer", async ({ answer }) => {
      console.log("[VideoScreen] webrtc-answer received");
      try {
        await setRemoteDescription(peerConnectionRef.current, answer);
        console.log("[VideoScreen] Remote description set");
        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");
      } catch (error) {
        console.error("Error setting remote description:", error);
        setMessage("Failed to establish connection.");
      }
    });

    newSocket.on("webrtc-ice-candidate", async ({ candidate }) => {
      console.log("[VideoScreen] webrtc-ice-candidate received");
      if (peerConnectionRef.current) {
        try {
          await addIceCandidate(peerConnectionRef.current, candidate);
          console.log("[VideoScreen] ICE candidate added");
        } catch (error) {
          console.error("Error adding ICE candidate:", error);
        }
      } else {
        // Queue candidates until peer connection is ready
        console.log("[VideoScreen] Queuing ICE candidate (peer connection not ready)");
        pendingCandidatesRef.current.push(candidate);
      }
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const setupPeerConnection = () => {
    if (!localStreamRef.current) {
      console.error("No local stream available");
      return;
    }

    const peerConnection = createPeerConnection(
      localStreamRef.current,
      (candidate) => {
        socketRef.current?.emit("webrtc-ice-candidate", { roomId: activeRoomRef.current, candidate });
      },
      (remoteStream) => {
        console.log("[VideoScreen] Received remote stream, tracks:", remoteStream.getTracks().length);
        if (remoteVideoRef.current) {
          console.log("[VideoScreen] Assigning stream to remote video element");
          remoteVideoRef.current.srcObject = remoteStream;
        } else {
          console.log("[VideoScreen] remoteVideoRef.current is null, cannot assign stream");
        }
      },
      (state) => {
        setConnectionState(state);
        if (state === "connected") {
          setMessage("Video call connected!");
        } else if (state === "failed" || state === "disconnected") {
          setMessage("Video call connection failed.");
        }
      }
    );

    peerConnectionRef.current = peerConnection;

    // Process any queued ICE candidates
    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift();
      addIceCandidate(peerConnection, candidate);
    }
  };

  const initiateWebRTCCall = async () => {
    if (!peerConnectionRef.current) {
      setupPeerConnection();
    }

    if (!peerConnectionRef.current) {
      setMessage("Failed to setup peer connection.");
      return;
    }

    try {
      const offer = await createOffer(peerConnectionRef.current);
      // Use activeRoom state directly instead of ref to avoid timing issues
      const currentRoomId = activeRoom || activeRoomRef.current;
      console.log("[VideoScreen] Sending webrtc-offer with roomId:", currentRoomId);
      socketRef.current?.emit("webrtc-offer", { roomId: currentRoomId, offer });
      setConnectionState("connecting");
      setMessage("Establishing WebRTC connection...");
    } catch (error) {
      console.error("Error creating offer:", error);
      setMessage("Failed to initiate call.");
    }
  };

  const cleanupWebRTC = () => {
    if (peerConnectionRef.current) {
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
    }
    pendingCandidatesRef.current = [];
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setConnectionState("disconnected");
  };

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom) {
      return;
    }

    const acquireMedia = async () => {
      try {
        setMessage("Requesting camera and microphone...");
        const stream = await getMediaStream();
        localStreamRef.current = stream;

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        setMessage("Camera and microphone ready.");
      } catch (error) {
        console.error("Failed to acquire media:", error);
        setMessage(error.message || "Failed to access camera and microphone.");
        // Don't proceed with WebRTC if media acquisition failed
        return;
      }
    };

    acquireMedia();

    return () => {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }

      if (localStreamRef.current) {
        stopMediaStream(localStreamRef.current);
        localStreamRef.current = null;
      }
      cleanupWebRTC();
    };
  }, [activeRoom]);

  const createRoom = () => {
    if (!socket?.connected) {
      setMessage("Not connected to the server.");
      return;
    }

    socket.emit("create-room", (response) => {
      if (response?.success) {
        setRoomId(response.roomId);
        setActiveRoom(response.roomId);
        isRoomCreatorRef.current = true;
        setConnectionState("waiting");
        setMessage("Room created! Share the room ID with the other user.");
      } else {
        setMessage(response?.message || "Could not create room.");
      }
    });
  };

  const joinRoom = () => {
    if (!socket?.connected) {
      setMessage("Not connected to the server.");
      return;
    }

    if (!roomId.trim()) {
      setMessage("Please enter a room ID.");
      return;
    }

    socket.emit("join-room", roomId.trim(), (response) => {
      if (response?.success) {
        setActiveRoom(response.roomId);
        isRoomCreatorRef.current = false;
        setConnectionState("waiting");
        setMessage("Joined room successfully! Waiting for WebRTC connection...");
      } else {
        setMessage(response?.message || "Could not join room.");
      }
    });
  };

  const leaveRoom = () => {
    cleanupWebRTC();
    isRoomCreatorRef.current = false;
    
    // Reset control states
    setIsMicMuted(false);
    setIsCameraOff(false);

    if (!socket?.connected || !activeRoom) {
      setActiveRoom("");
      setParticipantJoined(false);
      setRoomId("");
      setMessage("Left the room. Create or join a new room.");
      return;
    }

    const roomToLeave = activeRoom;

    socket.emit("leave-room", roomToLeave, (response) => {
      if (response?.success) {
        setActiveRoom("");
        setParticipantJoined(false);
        setRoomId("");
        setMessage("Left the room. Create or join a new room.");
      } else {
        setMessage(response?.message || "Could not leave room.");
      }
    });
  };

  const toggleMic = () => {
    if (!localStreamRef.current) {
      console.warn("No local stream available to toggle microphone");
      return;
    }

    const audioTracks = localStreamRef.current.getAudioTracks();
    if (audioTracks.length === 0) {
      setMessage("No microphone track available in simulated mode.");
      return;
    }

    const newMutedState = !isMicMuted;
    audioTracks.forEach((track) => {
      track.enabled = !newMutedState;
    });

    setIsMicMuted(newMutedState);
    setMessage(newMutedState ? "Microphone muted" : "Microphone unmuted");
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) {
      console.warn("No local stream available to toggle camera");
      return;
    }

    const videoTracks = localStreamRef.current.getVideoTracks();
    if (videoTracks.length === 0) {
      setMessage("No video track available.");
      return;
    }

    const newCameraState = !isCameraOff;
    videoTracks.forEach((track) => {
      track.enabled = !newCameraState;
    });

    setIsCameraOff(newCameraState);
    setMessage(newCameraState ? "Camera turned off" : "Camera turned on");
  };

  const endCall = () => {
    // Call existing leaveRoom logic (which resets control states)
    leaveRoom();
  };

  if (!activeRoom) {
    return (
      <main className="app">
        <header className="app-header">
          <h1>VideoCall</h1>
        </header>
        <section className="room-card">
          <p className="subtitle">Create a room or join a friend's room.</p>

          <p className={connected ? "status connected" : "status"}>
            <span className="status-dot" />
            {connected ? "Server connected" : "Server disconnected"}
          </p>

          <button onClick={createRoom} disabled={!connected}>
            Create Room
          </button>

          <div className="divider">OR</div>

          <label htmlFor="roomId">Room ID</label>
          <input
            id="roomId"
            type="text"
            placeholder="Enter room ID"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
          />

          <button
            className="secondary"
            onClick={joinRoom}
            disabled={!connected}
          >
            Join Room
          </button>

          <p className="message">{message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app video-call">
      <header className="app-header">
        <h1>VideoCall</h1>
        <p className={connected ? "status connected" : "status"}>
          <span className="status-dot" />
          {connected ? "Connected" : "Disconnected"}
        </p>
      </header>

      <section className="video-container">
        <div className="video-wrapper">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="video-element"
          />
          <div className="video-label">{cameraLabel}</div>
        </div>

        <div className="video-wrapper">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="video-element"
            style={{ display: connectionState === "connected" ? "block" : "none" }}
          />
          {connectionState !== "connected" && (
            <div className="video-placeholder">
              <p>
                {connectionState === "connecting"
                  ? "Connecting..."
                  : connectionState === "failed"
                  ? "Connection failed"
                  : participantJoined
                  ? "Remote participant"
                  : "Waiting for another participant..."}
              </p>
            </div>
          )}
          <div className="video-label">Remote participant</div>
        </div>
      </section>

      <section className="room-controls">
        <div className="room-info">
          <p>Room ID</p>
          <code>{activeRoom}</code>
          <button
            className="copy-button"
            onClick={() => navigator.clipboard.writeText(activeRoom)}
          >
            Copy
          </button>
        </div>

        <div className="participant-status">
          <span className="status-dot" />
          {participantJoined ? "Participant joined" : "Waiting for participant"}
        </div>

        <div className="call-controls">
          <button
            className={`control-button mic-button ${isMicMuted ? "muted" : ""}`}
            onClick={toggleMic}
            aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
            disabled={!localStreamRef.current}
          >
            {isMicMuted ? "🎤 Unmute" : "🎤 Mute"}
          </button>

          <button
            className={`control-button camera-button ${isCameraOff ? "off" : ""}`}
            onClick={toggleCamera}
            aria-label={isCameraOff ? "Turn on camera" : "Turn off camera"}
            disabled={!localStreamRef.current}
          >
            {isCameraOff ? "📷 On" : "📷 Off"}
          </button>

          <button
            className="control-button end-call-button"
            onClick={endCall}
            aria-label="End call"
          >
            📞 End Call
          </button>
        </div>

        <p className="message">{message}</p>
      </section>
    </main>
  );
}

export default VideoScreen;
