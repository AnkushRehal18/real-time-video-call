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
  // FIX (Bug 1 + 2): Track media readiness so BOTH the offerer AND the answerer
  // never create a peer connection before local tracks are available.
  //
  // Problem: when the room creator receives "user-joined", initiateWebRTCCall()
  // runs immediately. When the joiner receives "webrtc-offer", it also runs
  // without waiting. In both cases getMediaStream() is async —
  // localStreamRef.current may still be null at that point. createPeerConnection()
  // then falls through to the recvonly transceiver path, producing a connection
  // that carries no local video. The remote peer never receives video from the
  // party that raced.
  //
  // Fix: store a Promise that resolves when media acquisition completes (either
  // with a stream or with null). Both initiateWebRTCCall() (offerer) and the
  // webrtc-offer handler (answerer) await it before proceeding.
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
    console.log(`[WebRTC] drainPendingCandidates: applying ${queued} queued candidate(s)`);
    let applied = 0;
    let failed = 0;
    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift();
      try {
        await addIceCandidate(pc, candidate);
        applied++;
      } catch (err) {
        // A stale or invalid candidate from a previous session — safe to ignore.
        console.warn("[WebRTC] drainPendingCandidates: failed to apply candidate:", err.message);
        failed++;
      }
    }
    console.log(`[WebRTC] drainPendingCandidates: applied=${applied} failed=${failed}`);
  }, []);

  /**
   * Creates the RTCPeerConnection, wires up callbacks, and stores it in the
   * ref. Returns the existing connection if one is already active.
   *
   * IMPORTANT: must only be called after localStreamRef.current is settled
   * (either a valid stream or confirmed null). Use initiateWebRTCCall() for
   * the offerer path and always await mediaReadyRef first for the answerer
   * path — both paths now correctly wait for media.
   */
  const setupPeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      console.log("[WebRTC] setupPeerConnection: reusing existing connection");
      return peerConnectionRef.current;
    }

    const role = isRoomCreatorRef.current ? "offerer" : "answerer";
    const tracks = localStreamRef.current?.getTracks() ?? [];
    console.log(`[WebRTC] setupPeerConnection: creating new RTCPeerConnection as ${role}`, {
      localStreamPresent: !!localStreamRef.current,
      trackCount: tracks.length,
      tracks: tracks.map((t) => ({
        kind: t.kind,
        enabled: t.enabled,
        readyState: t.readyState,
      })),
    });

    const pc = createPeerConnection(
      localStreamRef.current,
      (candidate) => {
        const sock = socketRef.current;
        const room = activeRoomRef.current;
        console.log("[WebRTC] ICE candidate ready to emit", {
          socketConnected: !!sock?.connected,
          roomId: room || "(none)",
        });
        sock?.emit("webrtc-ice-candidate", {
          roomId: room,
          candidate,
        });
      },
      (remoteStream) => {
        // ontrack callback
        const videoTracks = remoteStream.getVideoTracks();
        const audioTracks = remoteStream.getAudioTracks();
        console.log("[RemoteMedia] onTrack: remote stream received", {
          streamId: remoteStream.id,
          videoTracks: videoTracks.length,
          audioTracks: audioTracks.length,
          videoTrackStates: videoTracks.map((t) => ({
            readyState: t.readyState,
            enabled: t.enabled,
            muted: t.muted,
          })),
        });
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
          console.log("[RemoteMedia] srcObject assigned to remote video element");
          remoteVideoRef.current.play().then(() => {
            console.log("[RemoteMedia] remote video play() succeeded");
          }).catch((err) => {
            // Autoplay may be blocked; the user can tap the video to play.
            console.warn("[RemoteMedia] remote video play() blocked:", err.message);
          });
        } else {
          console.warn("[RemoteMedia] onTrack: remoteVideoRef.current is null — element not mounted yet");
        }
      },
      (state) => {
        console.log(`[WebRTC] connectionState →`, state, { timestamp: new Date().toISOString() });
        setConnectionState(state);
        if (state === "connected") {
          setMessage("Video call connected!");
          // Double-check remote video element dimensions when connected
          setTimeout(() => {
            const el = remoteVideoRef.current;
            if (el) {
              console.log("[RemoteMedia] connected check", {
                hasSrcObject: !!el.srcObject,
                videoWidth: el.videoWidth,
                videoHeight: el.videoHeight,
                paused: el.paused,
                muted: el.muted,
              });
            }
          }, 1000);
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
      console.log("[WebRTC] cleanupWebRTC: closing peer connection");
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
    }
    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;
    // FIX (Bug 4): Reset media-ready promise so a re-join gets a fresh promise
    // rather than awaiting a promise that resolved for a previous session.
    mediaReadyRef.current = null;
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
    console.log("[WebRTC] initiateWebRTCCall: waiting for media to be ready...", {
      timestamp: new Date().toISOString(),
    });

    // Await the media promise so we never race against getMediaStream()
    if (mediaReadyRef.current) {
      await mediaReadyRef.current;
    }

    console.log("[LocalMedia] initiateWebRTCCall: media ready", {
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
      const sock = socketRef.current;
      const room = activeRoomRef.current;
      console.log("[WebRTC] offer emitting", {
        roomId: room,
        socketConnected: !!sock?.connected,
        signalingState: pc.signalingState,
      });
      sock?.emit("webrtc-offer", {
        roomId: room,
        offer,
      });
      console.log("[WebRTC] offer emitted to room", room);
      setConnectionState("connecting");
      setMessage("Establishing WebRTC connection...");
    } catch (err) {
      console.error("[WebRTC] initiateWebRTCCall: failed to create/send offer:", err.message);
      setMessage("Failed to initiate call.");
    }
  }, [setupPeerConnection]);

  // ---------------------------------------------------------------------------
  // Socket setup — registered ONCE on mount (dependency array is intentionally
  // empty). All callbacks read current values through refs, so stale closure
  // is not an issue. Using callbacks in the dep array would recreate the socket
  // on every render, disconnecting both peers unexpectedly.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    console.log("[Socket.IO] creating socket connection to", SOCKET_URL);
    const newSocket = io(SOCKET_URL, {
      // Use the default transports (polling → websocket upgrade).
      // Do not force websocket-only here as some environments need polling first.
    });
    socketRef.current = newSocket;

    newSocket.on("connect", () => {
      console.log("[Socket.IO] connected", {
        id: newSocket.id,
        transport: newSocket.io?.engine?.transport?.name,
        timestamp: new Date().toISOString(),
      });
      setConnected(true);
      setMessage("Connected to server. Create or join a room.");
    });

    newSocket.on("connect_error", (error) => {
      console.error("[Socket.IO] connect_error:", error.message, {
        timestamp: new Date().toISOString(),
      });
      setMessage(`Connection failed: ${error.message}`);
    });

    newSocket.on("disconnect", (reason) => {
      const transport = newSocket.io?.engine?.transport?.name ?? "unknown";
      console.log("[Socket.IO] disconnected", {
        reason,
        transport,
        willAutoReconnect: reason !== "io server disconnect" && reason !== "io client disconnect",
        timestamp: new Date().toISOString(),
      });
      setConnected(false);

      // Only clear room state for deliberate disconnects. For ping timeout /
      // transport close the socket will auto-reconnect — we keep the room
      // state so reconnect handler can rejoin.
      if (reason === "io server disconnect" || reason === "io client disconnect") {
        setActiveRoom("");
        activeRoomRef.current = "";
        setParticipantJoined(false);
        setMessage("Disconnected from server.");
      } else {
        setMessage("Connection lost — reconnecting...");
      }
    });

    // FIX (Bug 6): Reconnect handler. After a ping timeout or transport close
    // Socket.IO auto-reconnects, but the server-side rooms are empty again.
    // We must re-emit join-room so signaling can resume.
    newSocket.on("reconnect", (attemptNumber) => {
      console.log("[Socket.IO] reconnected", {
        attemptNumber,
        id: newSocket.id,
        transport: newSocket.io?.engine?.transport?.name,
        timestamp: new Date().toISOString(),
      });
      setConnected(true);

      const room = activeRoomRef.current;
      if (room) {
        console.log("[Socket.IO] re-joining room after reconnect:", room);
        setMessage("Reconnected — rejoining room...");

        newSocket.emit("join-room", room, (response) => {
          if (response?.success) {
            console.log("[Socket.IO] room rejoined successfully after reconnect:", room);
            setMessage("Rejoined room. Waiting for peer...");

            // If we were the room creator, re-initiate the WebRTC offer.
            // The peer connection would have been cleaned up on disconnect.
            if (isRoomCreatorRef.current && !peerConnectionRef.current) {
              console.log("[WebRTC] re-initiating call after reconnect (we are the offerer)");
              initiateWebRTCCall();
            }
          } else {
            console.warn("[Socket.IO] failed to rejoin room after reconnect:", response?.message);
            setMessage(response?.message || "Could not rejoin room after reconnect.");
            // Room may have expired — clear room state so user can start fresh.
            setActiveRoom("");
            activeRoomRef.current = "";
            setParticipantJoined(false);
          }
        });
      }
    });

    newSocket.on("reconnect_attempt", (attemptNumber) => {
      console.log("[Socket.IO] reconnect_attempt", { attemptNumber, timestamp: new Date().toISOString() });
    });

    newSocket.on("reconnect_error", (err) => {
      console.error("[Socket.IO] reconnect_error:", err.message);
    });

    newSocket.on("reconnect_failed", () => {
      console.error("[Socket.IO] reconnect_failed — all retries exhausted");
      setMessage("Failed to reconnect to server. Please refresh.");
    });

    newSocket.on("user-joined", ({ socketId }) => {
      console.log("[Socket.IO] user-joined", {
        socketId,
        isRoomCreator: isRoomCreatorRef.current,
        room: activeRoomRef.current,
        timestamp: new Date().toISOString(),
      });
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
      console.log("[Socket.IO] user-left", { socketId, timestamp: new Date().toISOString() });
      setParticipantJoined(false);
      setConnectionState("disconnected");
      setMessage(`Participant ${socketId} left the room.`);
      cleanupWebRTC();
    });

    // ------------------------------------------------------------------
    // Answerer path: receive offer → set remote description → send answer
    // FIX (Bug 2): await mediaReadyRef BEFORE setupPeerConnection() so that
    // localStreamRef.current is always settled when the PC is created.
    // Without this await the answerer may race against getMediaStream() and
    // create recvonly transceivers, sending no video to the offerer.
    // ------------------------------------------------------------------
    newSocket.on("webrtc-offer", async ({ offer }) => {
      const room = activeRoomRef.current;
      console.log("[WebRTC] offer received — waiting for local media before proceeding", {
        roomId: room,
        socketConnected: newSocket.connected,
        timestamp: new Date().toISOString(),
      });

      // Wait for media acquisition to complete before creating the peer
      // connection. This is the critical fix for the answerer path.
      if (mediaReadyRef.current) {
        await mediaReadyRef.current;
      }

      console.log("[LocalMedia] answerer: media ready before creating PC", {
        present: !!localStreamRef.current,
        tracks: localStreamRef.current?.getTracks().map((t) => ({
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState,
        })) ?? [],
      });

      const pc = setupPeerConnection();

      try {
        console.log("[WebRTC] setRemoteDescription (offer) starting", {
          signalingState: pc.signalingState,
        });
        // createAnswer sets the remote description then the local description.
        await createAnswer(pc, offer);
        remoteDescriptionSetRef.current = true;
        console.log("[WebRTC] answer created and local description set, remoteDescriptionSet=true", {
          signalingState: pc.signalingState,
        });

        const answer = pc.localDescription;
        console.log("[WebRTC] answer emitting to room", room, {
          socketConnected: newSocket.connected,
        });
        newSocket.emit("webrtc-answer", {
          roomId: room,
          answer,
        });
        console.log("[WebRTC] answer emitted to room", room);

        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");

        // Drain any ICE candidates that arrived before the remote description.
        await drainPendingCandidates(pc);
      } catch (err) {
        console.error("[WebRTC] webrtc-offer handler error:", err.message, err.stack);
        setMessage("Failed to establish connection.");
      }
    });

    // ------------------------------------------------------------------
    // Offerer path: receive answer → set remote description
    // ------------------------------------------------------------------
    newSocket.on("webrtc-answer", async ({ answer }) => {
      console.log("[WebRTC] answer received", {
        socketConnected: newSocket.connected,
        hasPeerConnection: !!peerConnectionRef.current,
        timestamp: new Date().toISOString(),
      });
      const pc = peerConnectionRef.current;
      if (!pc) {
        console.warn("[WebRTC] webrtc-answer: no peer connection exists, ignoring");
        return;
      }

      try {
        console.log("[WebRTC] setRemoteDescription (answer) starting", {
          signalingState: pc.signalingState,
        });
        await setRemoteDescription(pc, answer);
        remoteDescriptionSetRef.current = true;
        console.log("[WebRTC] remote description (answer) set, remoteDescriptionSet=true", {
          signalingState: pc.signalingState,
        });

        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");

        // Drain any ICE candidates that arrived before the remote description.
        await drainPendingCandidates(pc);
      } catch (err) {
        console.error("[WebRTC] webrtc-answer handler error:", err.message, err.stack);
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
        console.log("[WebRTC] ICE candidate buffered (remoteDesc not set yet)", {
          queueLength: pendingCandidatesRef.current.length + 1,
          hasPc: !!peerConnectionRef.current,
          remoteDescSet: remoteDescriptionSetRef.current,
        });
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      try {
        await addIceCandidate(peerConnectionRef.current, candidate);
        console.log("[WebRTC] ICE candidate applied immediately");
      } catch (err) {
        // Stale or invalid candidate — safe to discard.
        console.warn("[WebRTC] addIceCandidate failed:", err.message);
      }
    });

    return () => {
      console.log("[Socket.IO] disconnecting socket on unmount");
      newSocket.disconnect();
    };
    // FIX (Bug 1): Empty dependency array — this effect must run exactly ONCE
    // on mount. All callbacks use refs (socketRef, activeRoomRef, etc.) to
    // access current values, so stale closures are not a concern. Having
    // function references in this dep array caused the socket to be torn down
    // and recreated on every render cycle, disconnecting peers mid-call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Both initiateWebRTCCall() (offerer) and the webrtc-offer handler
    // (answerer) await this before creating the peer connection.
    let resolveMediaReady;
    mediaReadyRef.current = new Promise((resolve) => {
      resolveMediaReady = resolve;
    });
    mediaReadyResolveRef.current = resolveMediaReady;

    const acquireMedia = async () => {
      console.log("[LocalMedia] acquiring media stream...", {
        room: activeRoom,
        timestamp: new Date().toISOString(),
      });
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
          console.log("[LocalMedia] stream acquired successfully", {
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
          console.warn("[LocalMedia] getMediaStream() returned null — receive-only mode");
        }
      } catch (error) {
        localStreamRef.current = null;
        setHasLocalStream(false);
        console.error("[LocalMedia] media acquisition failed:", error.message);
        setMessage(
          error instanceof Error
            ? error.message
            : "Failed to access camera and microphone. You can still receive remote video."
        );
      } finally {
        // Always resolve so both offerer and answerer are never blocked indefinitely.
        resolveMediaReady(localStreamRef.current);
        console.log("[LocalMedia] mediaReady promise resolved", {
          streamPresent: !!localStreamRef.current,
        });
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
        console.log("[Socket.IO] room created", {
          roomId: response.roomId,
          isRoomCreator: true,
        });
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
        console.log("[Socket.IO] room joined", {
          roomId: response.roomId,
          isRoomCreator: false,
        });
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
        console.log("[Socket.IO] left room", roomToLeave);
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

        {/* FIX (Bug 5): The remote video element is ALWAYS present in the DOM.
            Previously display:none was toggled based on connectionState, which
            caused play() to silently fail on some browsers because playing a
            hidden element is blocked. Instead we overlay a placeholder div on
            top and hide the placeholder (not the video) when connected. */}
        <div className="video-wrapper">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="video-element"
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
