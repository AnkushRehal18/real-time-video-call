import { useEffect, useState, useRef, useCallback } from "react";
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
const CAMERA_LABEL = getCameraLabel();

function VideoScreen() {
  const [roomId, setRoomId] = useState("");
  const [message, setMessage] = useState("Connecting to server...");
  const [connected, setConnected] = useState(false);
  const [activeRoom, setActiveRoom] = useState("");
  const [participantJoined, setParticipantJoined] = useState(false);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  // Tracks whether we currently have a local media stream so controls can be
  // enabled/disabled correctly without reading a ref during render.
  const [hasLocalStream, setHasLocalStream] = useState(false);

  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);

  // ICE candidates received before the remote description is set are buffered
  // here and applied once the remote description is available.
  const pendingCandidatesRef = useRef([]);

  // Whether the remote description has been applied on the current peer
  // connection. A ref (not state) so that the socket event handlers — which
  // are registered once and close over this value — always read the latest
  // value without stale-closure issues.
  const remoteDescriptionSetRef = useRef(false);

  // Whether this client created the room (i.e. is the offerer).
  const isRoomCreatorRef = useRef(false);

  // Mirrors the activeRoom state so socket handlers (registered once) can
  // always read the current room id without stale-closure issues.
  const activeRoomRef = useRef("");

  // Mirrors the socket instance so stable callbacks can access it without
  // being listed as dependencies of the socket effect.
  const socketRef = useRef(null);

  // ---------------------------------------------------------------------------
  // FIX: Track media readiness so the offerer never creates a peer connection
  // before local tracks are available.
  //
  // Problem: when the room creator receives "user-joined", initiateWebRTCCall()
  // runs immediately. But getMediaStream() is async — localStreamRef.current
  // may still be null at that point. createPeerConnection() then falls through
  // to the recvonly transceiver path, producing an offer with recvonly video.
  // The answerer honours that direction and does not send video back, so the
  // offerer never sees the remote stream.
  //
  // Fix: store a Promise that resolves when media acquisition completes (either
  // with a stream or with null). initiateWebRTCCall() awaits it before
  // proceeding so the peer connection is always created with the correct tracks.
  // ---------------------------------------------------------------------------
  const mediaReadyRef = useRef(null);       // Promise<MediaStream|null>
  const mediaReadyResolveRef = useRef(null); // resolver fn for that Promise

  // ---------------------------------------------------------------------------
  // WebRTC helpers
  // ---------------------------------------------------------------------------

  /**
   * Drains all buffered ICE candidates into the peer connection.
   * Must only be called after the remote description has been set.
   */
  const drainPendingCandidates = useCallback(async (pc) => {
    const queued = pendingCandidatesRef.current.length;
    console.log(`[VideoScreen] drainPendingCandidates: applying ${queued} queued candidate(s)`);
    let applied = 0;
    let failed = 0;
    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift();
      try {
        await addIceCandidate(pc, candidate);
        applied++;
      } catch (err) {
        // A stale or invalid candidate from a previous session — safe to ignore.
        console.warn("[VideoScreen] drainPendingCandidates: failed to apply candidate:", err.message);
        failed++;
      }
    }
    console.log(`[VideoScreen] drainPendingCandidates: applied=${applied} failed=${failed}`);
  }, []);

  /**
   * Creates the RTCPeerConnection, wires up callbacks, and stores it in the
   * ref. Returns the existing connection if one is already active.
   *
   * IMPORTANT: must only be called after localStreamRef.current is settled
   * (either a valid stream or confirmed null). Use initiateWebRTCCall() for
   * the offerer path — it awaits mediaReadyRef first.
   */
  const setupPeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      console.log("[VideoScreen] setupPeerConnection: reusing existing connection");
      return peerConnectionRef.current;
    }

    const role = isRoomCreatorRef.current ? "offerer" : "answerer";
    console.log(`[VideoScreen] setupPeerConnection: creating new RTCPeerConnection as ${role}`, {
      localStreamTracks: localStreamRef.current?.getTracks().map((t) => ({
        kind: t.kind,
        enabled: t.enabled,
        readyState: t.readyState,
      })) ?? "NO_STREAM",
    });

    const pc = createPeerConnection(
      localStreamRef.current,
      (candidate) => {
        socketRef.current?.emit("webrtc-ice-candidate", {
          roomId: activeRoomRef.current,
          candidate,
        });
      },
      (remoteStream) => {
        console.log("[VideoScreen] onTrack callback: assigning srcObject to remote video element", {
          streamId: remoteStream.id,
          videoTracks: remoteStream.getVideoTracks().length,
          audioTracks: remoteStream.getAudioTracks().length,
          videoTrackStates: remoteStream.getVideoTracks().map((t) => ({
            readyState: t.readyState,
            enabled: t.enabled,
            muted: t.muted,
          })),
        });
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
          remoteVideoRef.current.play().catch((err) => {
            // Autoplay may be blocked; the user can tap the video to play.
            console.warn("[VideoScreen] remoteVideo.play() blocked:", err.message);
          });
        } else {
          console.warn("[VideoScreen] onTrack callback: remoteVideoRef.current is null — element not mounted yet");
        }
      },
      (state) => {
        console.log(`[VideoScreen] connectionState callback: state=${state}`);
        setConnectionState(state);
        if (state === "connected") {
          setMessage("Video call connected!");
        } else if (state === "failed" || state === "disconnected") {
          setMessage("Video call connection failed.");
        }
      },
      role
    );

    peerConnectionRef.current = pc;
    return pc;
  }, []);

  /**
   * Tears down the active peer connection and resets all related state.
   */
  const cleanupWebRTC = useCallback(() => {
    if (peerConnectionRef.current) {
      console.log("[VideoScreen] cleanupWebRTC: closing peer connection");
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
    }
    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setConnectionState("disconnected");
  }, []);

  /**
   * Creates an offer using the current peer connection and sends it to the
   * room.
   *
   * Awaits mediaReadyRef before creating the peer connection so that
   * localStreamRef.current is always settled (stream or null) by the time
   * createPeerConnection() is called. This prevents the offerer from
   * accidentally creating a recvonly offer when media acquisition is still
   * in progress.
   */
  const initiateWebRTCCall = useCallback(async () => {
    console.log("[VideoScreen] initiateWebRTCCall: waiting for media to be ready...");

    // Await the media promise so we never race against getMediaStream()
    if (mediaReadyRef.current) {
      await mediaReadyRef.current;
    }

    console.log("[VideoScreen] initiateWebRTCCall: media ready, local stream:", {
      present: !!localStreamRef.current,
      tracks: localStreamRef.current?.getTracks().map((t) => ({
        kind: t.kind,
        enabled: t.enabled,
        readyState: t.readyState,
      })) ?? [],
    });

    const pc = setupPeerConnection();

    try {
      const offer = await createOffer(pc);
      socketRef.current?.emit("webrtc-offer", {
        roomId: activeRoomRef.current,
        offer,
      });
      console.log("[VideoScreen] initiateWebRTCCall: offer emitted to room", activeRoomRef.current);
      setConnectionState("connecting");
      setMessage("Establishing WebRTC connection...");
    } catch (err) {
      console.error("[VideoScreen] initiateWebRTCCall: failed to create/send offer:", err.message);
      setMessage("Failed to initiate call.");
    }
  }, [setupPeerConnection]);

  // ---------------------------------------------------------------------------
  // Socket setup — registered once on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    socketRef.current = newSocket;

    newSocket.on("connect", () => {
      console.log("[VideoScreen] socket connected:", newSocket.id);
      setConnected(true);
      setMessage("Connected to server. Create or join a room.");
    });

    newSocket.on("connect_error", (error) => {
      console.error("[VideoScreen] socket connect_error:", error.message);
      setMessage(`Connection failed: ${error.message}`);
    });

    newSocket.on("disconnect", (reason) => {
      console.log("[VideoScreen] socket disconnected:", reason);
      setConnected(false);
      setActiveRoom("");
      activeRoomRef.current = "";
      setParticipantJoined(false);
      setMessage("Disconnected from server.");
    });

    newSocket.on("user-joined", ({ socketId }) => {
      console.log("[VideoScreen] user-joined:", socketId, "| isRoomCreator:", isRoomCreatorRef.current);
      setParticipantJoined(true);
      setMessage(`Another user joined the room: ${socketId}`);

      // Only the room creator sends the initial offer.
      // activeRoomRef is used here (not the activeRoom state) to avoid the
      // stale-closure problem — the ref is always up-to-date.
      if (isRoomCreatorRef.current) {
        initiateWebRTCCall();
      }
    });

    newSocket.on("user-left", ({ socketId }) => {
      console.log("[VideoScreen] user-left:", socketId);
      setParticipantJoined(false);
      setConnectionState("disconnected");
      setMessage(`Participant ${socketId} left the room.`);
      cleanupWebRTC();
    });

    // ------------------------------------------------------------------
    // Answerer path: receive offer → set remote description → send answer
    // ------------------------------------------------------------------
    newSocket.on("webrtc-offer", async ({ offer }) => {
      console.log("[VideoScreen] webrtc-offer received, setting up answerer peer connection");
      const pc = setupPeerConnection();

      try {
        // createAnswer sets the remote description then the local description.
        await createAnswer(pc, offer);
        remoteDescriptionSetRef.current = true;
        console.log("[VideoScreen] webrtc-offer: remote+local descriptions set, remoteDescriptionSet=true");

        newSocket.emit("webrtc-answer", {
          roomId: activeRoomRef.current,
          answer: pc.localDescription,
        });
        console.log("[VideoScreen] webrtc-offer: answer emitted to room", activeRoomRef.current);

        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");

        // Drain any ICE candidates that arrived before the remote description.
        await drainPendingCandidates(pc);
      } catch (err) {
        console.error("[VideoScreen] webrtc-offer handler error:", err.message, err.stack);
        setMessage("Failed to establish connection.");
      }
    });

    // ------------------------------------------------------------------
    // Offerer path: receive answer → set remote description
    // ------------------------------------------------------------------
    newSocket.on("webrtc-answer", async ({ answer }) => {
      console.log("[VideoScreen] webrtc-answer received");
      const pc = peerConnectionRef.current;
      if (!pc) {
        console.warn("[VideoScreen] webrtc-answer: no peer connection exists, ignoring");
        return;
      }

      try {
        await setRemoteDescription(pc, answer);
        remoteDescriptionSetRef.current = true;
        console.log("[VideoScreen] webrtc-answer: remote description set, remoteDescriptionSet=true");

        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");

        // Drain any ICE candidates that arrived before the remote description.
        await drainPendingCandidates(pc);
      } catch (err) {
        console.error("[VideoScreen] webrtc-answer handler error:", err.message, err.stack);
        setMessage("Failed to establish connection.");
      }
    });

    // ------------------------------------------------------------------
    // ICE candidates — buffer until remote description is set
    // ------------------------------------------------------------------
    newSocket.on("webrtc-ice-candidate", async ({ candidate }) => {
      // remoteDescriptionSetRef and peerConnectionRef are refs, so this
      // handler always reads their current values rather than stale closure
      // values captured at registration time.
      if (!peerConnectionRef.current || !remoteDescriptionSetRef.current) {
        console.log("[VideoScreen] webrtc-ice-candidate: buffering (remoteDesc not set yet), queue length:", pendingCandidatesRef.current.length + 1);
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      try {
        await addIceCandidate(peerConnectionRef.current, candidate);
        console.log("[VideoScreen] webrtc-ice-candidate: applied immediately");
      } catch (err) {
        // Stale or invalid candidate — safe to discard.
        console.warn("[VideoScreen] webrtc-ice-candidate: addIceCandidate failed:", err.message);
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, [initiateWebRTCCall, cleanupWebRTC, setupPeerConnection, drainPendingCandidates]);

  // ---------------------------------------------------------------------------
  // Media acquisition — runs when the user enters or changes a room
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!activeRoom) {
      return;
    }

    // Keep the ref in sync with state so socket handlers always see the
    // current room id.
    activeRoomRef.current = activeRoom;

    // Capture the video element reference at effect time for safe use in
    // cleanup (the ref value may have changed by then).
    const localVideoEl = localVideoRef.current;

    // Create a new media-ready promise for this room session.
    // initiateWebRTCCall() will await this before proceeding.
    let resolveMediaReady;
    mediaReadyRef.current = new Promise((resolve) => {
      resolveMediaReady = resolve;
    });
    mediaReadyResolveRef.current = resolveMediaReady;

    const acquireMedia = async () => {
      try {
        setMessage("Requesting camera and microphone...");
        const stream = await getMediaStream();

        if (stream) {
          localStreamRef.current = stream;
          setHasLocalStream(true);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }
          setMessage("Camera and microphone ready.");
          console.log("[VideoScreen] acquireMedia: stream acquired", {
            tracks: stream.getTracks().map((t) => ({
              kind: t.kind,
              enabled: t.enabled,
              readyState: t.readyState,
            })),
          });
        } else {
          localStreamRef.current = null;
          setHasLocalStream(false);
          setMessage("No camera/microphone available. You can still receive remote video.");
          console.warn("[VideoScreen] acquireMedia: getMediaStream() returned null");
        }
      } catch (error) {
        localStreamRef.current = null;
        setHasLocalStream(false);
        console.error("[VideoScreen] acquireMedia error:", error.message);
        setMessage(
          error instanceof Error
            ? error.message
            : "Failed to access camera and microphone. You can still receive remote video."
        );
      } finally {
        // Always resolve so initiateWebRTCCall() is never blocked indefinitely.
        resolveMediaReady(localStreamRef.current);
        console.log("[VideoScreen] acquireMedia: mediaReady resolved, stream present:", !!localStreamRef.current);
      }
    };

    acquireMedia();

    return () => {
      if (localVideoEl) {
        localVideoEl.srcObject = null;
      }
      if (localStreamRef.current) {
        stopMediaStream(localStreamRef.current);
        localStreamRef.current = null;
        setHasLocalStream(false);
      }
      cleanupWebRTC();
    };
  }, [activeRoom, cleanupWebRTC]);

  // ---------------------------------------------------------------------------
  // Room actions
  // ---------------------------------------------------------------------------

  const createRoom = () => {
    const sock = socketRef.current;
    if (!sock?.connected) {
      setMessage("Not connected to the server.");
      return;
    }

    sock.emit("create-room", (response) => {
      if (response?.success) {
        console.log("[VideoScreen] createRoom: room created, isRoomCreator=true", response.roomId);
        setRoomId(response.roomId);
        setActiveRoom(response.roomId);
        activeRoomRef.current = response.roomId;
        isRoomCreatorRef.current = true;
        setConnectionState("waiting");
        setMessage("Room created! Share the room ID with the other user.");
      } else {
        setMessage(response?.message || "Could not create room.");
      }
    });
  };

  const joinRoom = () => {
    const sock = socketRef.current;
    if (!sock?.connected) {
      setMessage("Not connected to the server.");
      return;
    }

    if (!roomId.trim()) {
      setMessage("Please enter a room ID.");
      return;
    }

    sock.emit("join-room", roomId.trim(), (response) => {
      if (response?.success) {
        console.log("[VideoScreen] joinRoom: joined, isRoomCreator=false", response.roomId);
        setActiveRoom(response.roomId);
        activeRoomRef.current = response.roomId;
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
    setIsMicMuted(false);
    setIsCameraOff(false);

    const sock = socketRef.current;
    if (!sock?.connected || !activeRoom) {
      setActiveRoom("");
      activeRoomRef.current = "";
      setParticipantJoined(false);
      setRoomId("");
      setMessage("Left the room. Create or join a new room.");
      return;
    }

    const roomToLeave = activeRoom;

    sock.emit("leave-room", roomToLeave, (response) => {
      if (response?.success) {
        setActiveRoom("");
        activeRoomRef.current = "";
        setParticipantJoined(false);
        setRoomId("");
        setMessage("Left the room. Create or join a new room.");
      } else {
        setMessage(response?.message || "Could not leave room.");
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Media controls
  // ---------------------------------------------------------------------------

  const toggleMic = () => {
    if (!localStreamRef.current) return;

    const audioTracks = localStreamRef.current.getAudioTracks();
    if (audioTracks.length === 0) {
      setMessage("No microphone track available.");
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
    if (!localStreamRef.current) return;

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
    leaveRoom();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!activeRoom) {
    return (
      <main className="app">
        <header className="app-header">
          <h1>VideoCall</h1>
        </header>
        <section className="room-card">
          <p className="subtitle">Create a room or join a friend&apos;s room.</p>

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
          <div className="video-label">{CAMERA_LABEL}</div>
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
            disabled={!hasLocalStream}
          >
            {isMicMuted ? "🎤 Unmute" : "🎤 Mute"}
          </button>

          <button
            className={`control-button camera-button ${isCameraOff ? "off" : ""}`}
            onClick={toggleCamera}
            aria-label={isCameraOff ? "Turn on camera" : "Turn off camera"}
            disabled={!hasLocalStream}
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
