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
  // Floating local-camera PiP state
  //
  // These refs and state vars exist purely for presentation (draggable mini-
  // video overlay). They do not interact with WebRTC, media streams, or
  // signaling. localVideoRef and remoteVideoRef are reused as-is.
  // ---------------------------------------------------------------------------
  const [pipPos, setPipPos] = useState({ x: 0, y: 0 }); // position in px
  const [pipFit, setPipFit] = useState("cover");         // "cover" | "contain"
  const pipDragRef = useRef(null);   // { startX, startY, origX, origY, id }
  const pipContainerRef = useRef(null); // bounds the draggable area

  // ---------------------------------------------------------------------------
  // Media-ready promise + generation counter
  //
  // mediaReadyRef    — Promise<MediaStream|null> that resolves when the current
  //                    media acquisition attempt completes (success, failure, or
  //                    null stream). Awaited by initiateWebRTCCall() and the
  //                    webrtc-offer handler before creating a peer connection.
  //
  // mediaReadyResolveRef — resolver for that promise. Set when the promise is
  //                    created, cleared immediately after first call to prevent
  //                    double-resolve.
  //
  // mediaGenRef      — monotonically increasing integer. Incremented each time a
  //                    new media acquisition starts (ensureMediaReadyPromise) and
  //                    each time cleanupWebRTC invalidates the current session.
  //                    acquireMedia captures its generation at start and checks it
  //                    in the finally block: if the generation has changed, the
  //                    acquisition belongs to a cancelled session and its result
  //                    must not be applied. The same generation check in
  //                    initiateWebRTCCall / webrtc-offer handler prevents a
  //                    cancelled call from creating a new peer connection after
  //                    the await returns.
  // ---------------------------------------------------------------------------
  const mediaReadyRef = useRef(null);        // Promise<MediaStream|null>
  const mediaReadyResolveRef = useRef(null); // resolver fn for that Promise
  const mediaGenRef = useRef(0);             // cancellation generation counter

  // ---------------------------------------------------------------------------
  // WebRTC helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensures a media-ready promise exists for the current session.
   * Idempotent — safe to call multiple times; only creates a new promise when
   * the current one has been cleared (by cleanupWebRTC or never set).
   * Always increments the generation counter so that any in-flight
   * acquireMedia() from a previous session is invalidated.
   *
   * Called from createRoom(), joinRoom(), and the reconnect handler so that
   * EVERY entry point into a session creates the promise before signaling
   * can start.
   *
   * @param {string} caller - Label for diagnostic logging.
   */
  const ensureMediaReadyPromise = useCallback((caller) => {
    // Increment generation unconditionally. Even if a promise already exists
    // (re-entering the same session), a new generation invalidates any
    // acquireMedia() that may still be running from a prior call.
    mediaGenRef.current += 1;
    const gen = mediaGenRef.current;

    if (!mediaReadyRef.current) {
      let resolve;
      mediaReadyRef.current = new Promise((res) => { resolve = res; });
      mediaReadyResolveRef.current = resolve;
      console.log("[LocalMedia] media-ready promise created", {
        caller,
        generation: gen,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Promise already exists — a prior call to this function (or the media
      // useEffect) created it. Log the generation bump but keep the promise.
      console.log("[LocalMedia] media-ready promise already exists, generation bumped", {
        caller,
        generation: gen,
        timestamp: new Date().toISOString(),
      });
    }
  }, []);

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
   * Must only be called after awaiting the media-ready promise so that
   * localStreamRef.current is always settled (stream or confirmed null).
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
          // Double-check remote video element dimensions when connected.
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
   *
   * Increments mediaGenRef to invalidate any in-flight acquireMedia() or
   * initiateWebRTCCall() that is currently awaiting the media-ready promise.
   * Those calls check the generation after the await and abort if it has
   * changed, preventing a cancelled session from creating a new peer
   * connection or emitting a stale offer.
   *
   * Does NOT stop the local media stream — that is the responsibility of the
   * media useEffect cleanup, which manages stream lifecycle separately.
   *
   * @param {string} [reason] - Human-readable reason for diagnostic logging.
   */
  const cleanupWebRTC = useCallback((reason = "unspecified") => {
    // Bump the generation so any in-flight acquireMedia or initiateWebRTCCall
    // that is still awaiting mediaReadyRef knows it belongs to a dead session.
    mediaGenRef.current += 1;
    const gen = mediaGenRef.current;

    console.log("[WebRTC] cleanupWebRTC called", {
      reason,
      roomId: activeRoomRef.current || "(none)",
      hasPeerConnection: !!peerConnectionRef.current,
      newGeneration: gen,
      timestamp: new Date().toISOString(),
    });

    if (peerConnectionRef.current) {
      closePeerConnection(peerConnectionRef.current);
      peerConnectionRef.current = null;
    }

    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;

    // Resolve the outstanding promise with null so that any caller currently
    // awaiting it unblocks immediately rather than hanging forever. The
    // generation check that follows the await in each caller will then abort
    // the operation safely.
    const resolve = mediaReadyResolveRef.current;
    if (resolve) {
      resolve(null); // unblock any awaiter
      mediaReadyResolveRef.current = null;
    }
    mediaReadyRef.current = null;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setConnectionState("disconnected");
  }, []);

  /**
   * Awaits the current media-ready promise, then creates an offer and sends it.
   *
   * Uses the generation counter to detect if the session was cancelled while
   * waiting for media. If the generation changed, the offer is not sent and
   * the function returns silently — no peer connection is created for the
   * dead session.
   */
  const initiateWebRTCCall = useCallback(async () => {
    // Capture the generation at the start of this call attempt.
    const callGen = mediaGenRef.current;

    console.log("[WebRTC] initiateWebRTCCall: waiting for media to be ready...", {
      generation: callGen,
      mediaReadyPromiseExists: !!mediaReadyRef.current,
      timestamp: new Date().toISOString(),
    });

    // Always await the media promise. If it is null here we have a code path
    // that did not call ensureMediaReadyPromise() first — log a warning and
    // proceed; localStreamRef.current reflects current state.
    if (mediaReadyRef.current) {
      await mediaReadyRef.current;
    } else {
      console.warn("[WebRTC] initiateWebRTCCall: mediaReadyRef is null — ensureMediaReadyPromise() was not called before this path. Proceeding with current stream state.", {
        generation: callGen,
        streamPresent: !!localStreamRef.current,
      });
    }

    // After the await, check if this call attempt is still valid.
    if (mediaGenRef.current !== callGen) {
      console.log("[WebRTC] initiateWebRTCCall: session cancelled during media wait, aborting", {
        capturedGeneration: callGen,
        currentGeneration: mediaGenRef.current,
      });
      return;
    }

    console.log("[LocalMedia] initiateWebRTCCall: media ready", {
      generation: callGen,
      streamPresent: !!localStreamRef.current,
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

      // Check generation again after the async createOffer call.
      if (mediaGenRef.current !== callGen) {
        console.log("[WebRTC] initiateWebRTCCall: session cancelled during createOffer, aborting", {
          capturedGeneration: callGen,
          currentGeneration: mediaGenRef.current,
        });
        return;
      }

      console.log("[WebRTC] offer emitting", {
        roomId: room,
        socketConnected: !!sock?.connected,
        signalingState: pc.signalingState,
        generation: callGen,
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
      const transport = newSocket.io?.engine?.transport?.name ?? "unknown";
      console.log("[Socket.IO] connected", {
        id: newSocket.id,
        transport,
        timestamp: new Date().toISOString(),
      });
      setConnected(true);
      setMessage("Connected to server. Create or join a room.");

      // Log transport upgrades after initial connection so we can distinguish
      // websocket from long-poll in production without having to check DevTools.
      newSocket.io?.engine?.on("upgrade", (newTransport) => {
        console.log("[Socket.IO] transport upgraded", {
          from: transport,
          to: newTransport?.name ?? "unknown",
          timestamp: new Date().toISOString(),
        });
      });
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
      // transport close the socket will auto-reconnect — keep room state so
      // the reconnect handler can rejoin.
      if (reason === "io server disconnect" || reason === "io client disconnect") {
        setActiveRoom("");
        activeRoomRef.current = "";
        setParticipantJoined(false);
        setMessage("Disconnected from server.");
      } else {
        setMessage("Connection lost — reconnecting...");
      }
    });

    // After a ping-timeout or transport-close the socket auto-reconnects but
    // the server-side room membership is gone. Re-join and re-initiate if we
    // were the offerer.
    newSocket.on("reconnect", (attemptNumber) => {
      const transport = newSocket.io?.engine?.transport?.name ?? "unknown";
      console.log("[Socket.IO] reconnected", {
        attemptNumber,
        id: newSocket.id,
        transport,
        timestamp: new Date().toISOString(),
      });
      setConnected(true);

      const room = activeRoomRef.current;
      if (!room) {
        console.log("[Socket.IO] reconnect: no active room to rejoin");
        return;
      }

      console.log("[Socket.IO] re-joining room after reconnect", { room });
      setMessage("Reconnected — rejoining room...");

      // Pre-create the media-ready promise before emitting join-room.
      // If the stream is still alive this promise will be resolved immediately
      // by the media useEffect (which didn't run because activeRoom didn't
      // change). If cleanupWebRTC was called between disconnect and reconnect,
      // it will be resolved when acquireMedia() finishes after the re-render.
      ensureMediaReadyPromise("reconnect");

      newSocket.emit("join-room", room, (response) => {
        if (response?.success) {
          console.log("[Socket.IO] room rejoined after reconnect", {
            room,
            attemptNumber,
          });
          setMessage("Rejoined room. Waiting for peer...");

          // Only re-initiate the offer if we were the original offerer and
          // there is no existing peer connection (avoid duplicate offers).
          if (isRoomCreatorRef.current && !peerConnectionRef.current) {
            console.log("[WebRTC] re-initiating call after reconnect (offerer, no existing PC)");
            initiateWebRTCCall();
          } else if (peerConnectionRef.current) {
            console.log("[WebRTC] reconnect: existing PC still active, not re-initiating", {
              signalingState: peerConnectionRef.current.signalingState,
              connectionState: peerConnectionRef.current.connectionState,
            });
          }
        } else {
          // Room no longer exists — clear local state so the user can start fresh.
          // Capture the current room before clearing so the log is meaningful.
          const expiredRoom = activeRoomRef.current;
          console.warn("[Socket.IO] failed to rejoin room after reconnect — room may have expired", {
            room: expiredRoom,
            serverMessage: response?.message,
          });
          setActiveRoom("");
          activeRoomRef.current = "";
          setParticipantJoined(false);
          setMessage(response?.message || "Could not rejoin room — it may have expired. Please create a new room.");
        }
      });
    });

    newSocket.on("reconnect_attempt", (attemptNumber) => {
      console.log("[Socket.IO] reconnect_attempt", {
        attemptNumber,
        timestamp: new Date().toISOString(),
      });
    });

    newSocket.on("reconnect_error", (err) => {
      console.error("[Socket.IO] reconnect_error:", err.message, {
        timestamp: new Date().toISOString(),
      });
    });

    newSocket.on("reconnect_failed", () => {
      console.error("[Socket.IO] reconnect_failed — all retries exhausted", {
        timestamp: new Date().toISOString(),
      });
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
      if (isRoomCreatorRef.current) {
        initiateWebRTCCall();
      }
    });

    newSocket.on("user-left", ({ socketId }) => {
      console.log("[Socket.IO] user-left", {
        socketId,
        timestamp: new Date().toISOString(),
      });
      setParticipantJoined(false);
      setMessage(`Participant ${socketId} left the room.`);
      cleanupWebRTC("user-left event");
    });

    // ------------------------------------------------------------------
    // Answerer path: receive offer → await media → create answer
    // ------------------------------------------------------------------
    newSocket.on("webrtc-offer", async ({ offer }) => {
      // Capture generation before any async work.
      const callGen = mediaGenRef.current;
      const room = activeRoomRef.current;

      console.log("[WebRTC] offer received", {
        roomId: room,
        socketConnected: newSocket.connected,
        mediaReadyPromiseExists: !!mediaReadyRef.current,
        generation: callGen,
        timestamp: new Date().toISOString(),
      });

      if (!mediaReadyRef.current) {
        // The offer arrived before any call path created the promise.
        // This should not happen with the current pre-creation logic but is
        // logged as a warning so it's visible in production if it does.
        console.warn("[WebRTC] offer arrived but mediaReadyRef is null — proceeding with current stream state (no wait). This indicates ensureMediaReadyPromise() was not called before this offer arrived.", {
          generation: callGen,
          streamPresent: !!localStreamRef.current,
        });
      } else {
        console.log("[WebRTC] awaiting media-ready promise before creating PC...", {
          generation: callGen,
        });
        await mediaReadyRef.current;
        console.log("[WebRTC] media-ready promise resolved", {
          generation: callGen,
          streamPresent: !!localStreamRef.current,
        });
      }

      // After the await, verify the session is still valid.
      if (mediaGenRef.current !== callGen) {
        console.log("[WebRTC] offer handler: session cancelled during media wait, aborting", {
          capturedGeneration: callGen,
          currentGeneration: mediaGenRef.current,
        });
        return;
      }

      console.log("[LocalMedia] answerer: media settled before creating PC", {
        generation: callGen,
        streamPresent: !!localStreamRef.current,
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
        await createAnswer(pc, offer);
        remoteDescriptionSetRef.current = true;
        console.log("[WebRTC] answer created and local description set", {
          signalingState: pc.signalingState,
        });

        // Read the room ref again after the async createAnswer call — it may
        // have changed if the session was torn down mid-negotiation.
        const currentRoom = activeRoomRef.current;
        if (mediaGenRef.current !== callGen) {
          console.log("[WebRTC] offer handler: session cancelled during createAnswer, aborting", {
            capturedGeneration: callGen,
            currentGeneration: mediaGenRef.current,
          });
          return;
        }

        const answer = pc.localDescription;
        console.log("[WebRTC] answer emitting to room", currentRoom, {
          socketConnected: newSocket.connected,
          generation: callGen,
        });
        newSocket.emit("webrtc-answer", {
          roomId: currentRoom,
          answer,
        });
        console.log("[WebRTC] answer emitted");

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
        console.log("[WebRTC] remote description (answer) set", {
          signalingState: pc.signalingState,
        });

        setConnectionState("connecting");
        setMessage("Establishing WebRTC connection...");

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
    // Empty dependency array — this effect runs exactly once on mount.
    // All callbacks access current values through refs; stale closures are
    // not a concern. Adding function references here would recreate the socket
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Media acquisition — runs when the user enters a room
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!activeRoom) {
      return;
    }

    // Keep the ref in sync with state so socket handlers always read the
    // current room id.
    activeRoomRef.current = activeRoom;

    // Capture the video element reference for safe use in cleanup — the ref
    // value may have changed by the time cleanup runs.
    const localVideoEl = localVideoRef.current;

    // Ensure a media-ready promise exists for this session. If createRoom() or
    // joinRoom() already called ensureMediaReadyPromise(), this is a no-op
    // for the promise itself but still bumps the generation, ensuring that any
    // in-flight acquireMedia() from a previous session is invalidated.
    ensureMediaReadyPromise("media useEffect");

    // Capture the generation that this particular acquireMedia() call belongs to.
    const acquireGen = mediaGenRef.current;

    const acquireMedia = async () => {
      console.log("[LocalMedia] acquiring media stream...", {
        room: activeRoom,
        generation: acquireGen,
        timestamp: new Date().toISOString(),
      });
      try {
        setMessage("Requesting camera and microphone...");
        const stream = await getMediaStream();

        // Check generation before applying any results — cleanup may have run
        // while getUserMedia() was in progress (e.g., participant left).
        if (mediaGenRef.current !== acquireGen) {
          console.log("[LocalMedia] acquireMedia: session cancelled during getUserMedia, discarding result", {
            capturedGeneration: acquireGen,
            currentGeneration: mediaGenRef.current,
          });
          // Stop the stream immediately — it belongs to a dead session.
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
          }
          return;
        }

        if (stream) {
          localStreamRef.current = stream;
          setHasLocalStream(true);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }
          setMessage("Camera and microphone ready.");
          console.log("[LocalMedia] stream acquired successfully", {
            generation: acquireGen,
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
          console.warn("[LocalMedia] getMediaStream() returned null — receive-only mode", {
            generation: acquireGen,
          });
        }
      } catch (error) {
        if (mediaGenRef.current !== acquireGen) {
          console.log("[LocalMedia] acquireMedia: session cancelled, discarding error", {
            capturedGeneration: acquireGen,
            currentGeneration: mediaGenRef.current,
          });
          return;
        }
        localStreamRef.current = null;
        setHasLocalStream(false);
        console.error("[LocalMedia] media acquisition failed:", {
          generation: acquireGen,
          message: error.message,
        });
        setMessage(
          error instanceof Error
            ? error.message
            : "Failed to access camera and microphone. You can still receive remote video."
        );
      } finally {
        // Resolve the media-ready promise if this acquisition still owns it.
        // If cleanupWebRTC() ran concurrently, it already resolved the promise
        // with null and cleared mediaReadyResolveRef — the null check here
        // prevents a double-resolve and ensures we only settle the promise
        // that belongs to this generation.
        if (mediaGenRef.current === acquireGen) {
          const resolve = mediaReadyResolveRef.current;
          if (resolve) {
            resolve(localStreamRef.current);
            mediaReadyResolveRef.current = null;
          }
          console.log("[LocalMedia] mediaReady promise resolved", {
            generation: acquireGen,
            streamPresent: !!localStreamRef.current,
          });
        } else {
          console.log("[LocalMedia] acquireMedia finally: generation mismatch, promise already settled by cleanup", {
            capturedGeneration: acquireGen,
            currentGeneration: mediaGenRef.current,
          });
        }
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
      cleanupWebRTC("media useEffect cleanup (activeRoom changed or unmount)");
    };
  }, [activeRoom, cleanupWebRTC, ensureMediaReadyPromise]);

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
          timestamp: new Date().toISOString(),
        });

        // Pre-create the media-ready promise before setActiveRoom() triggers
        // the re-render + media useEffect. user-joined can fire quickly once
        // the other peer joins, and initiateWebRTCCall() must always find the
        // promise in place. This mirrors the equivalent fix in joinRoom().
        ensureMediaReadyPromise("createRoom");

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
          timestamp: new Date().toISOString(),
        });

        // Pre-create the media-ready promise HERE, synchronously in the join
        // callback, before setActiveRoom() triggers the React re-render and
        // media useEffect. The webrtc-offer event can arrive from the server
        // within milliseconds of this callback — before the media useEffect
        // has had a chance to run. If mediaReadyRef.current is still null at
        // that point, the offer handler's await is skipped and
        // setupPeerConnection() runs with a null stream (recvonly PC). Pre-
        // creating the promise here closes that window.
        ensureMediaReadyPromise("joinRoom");

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
    cleanupWebRTC("leaveRoom / endCall");
    isRoomCreatorRef.current = false;
    setIsMicMuted(false);
    setIsCameraOff(false);

    const sock = socketRef.current;
    const roomToLeave = activeRoom;

    // Clear local room state immediately so the UI transitions away regardless
    // of whether the server-side leave-room acknowledgment arrives.
    setActiveRoom("");
    activeRoomRef.current = "";
    setParticipantJoined(false);
    setRoomId("");
    setMessage("Left the room. Create or join a new room.");

    if (!sock?.connected || !roomToLeave) {
      return;
    }

    sock.emit("leave-room", roomToLeave, (response) => {
      if (response?.success) {
        console.log("[Socket.IO] left room", {
          room: roomToLeave,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Room state is already cleared — this is informational only.
        console.warn("[Socket.IO] leave-room server response:", response?.message, {
          room: roomToLeave,
        });
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
  // Local-camera PiP drag handlers (presentation only)
  // Works with both mouse and touch. Clamps to the container bounds so the
  // preview can never leave the visible video area.
  // ---------------------------------------------------------------------------

  const onPipPointerDown = useCallback((e) => {
    // Only start drag on primary button / single touch
    if (e.button !== undefined && e.button !== 0) return;

    const container = pipContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    pipDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pipPos.x,
      origY: pipPos.y,
      containerW: rect.width,
      containerH: rect.height,
    };

    // Capture the pointer so we keep receiving move events even if the cursor
    // leaves the overlay. This also makes touch dragging work reliably.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, [pipPos.x, pipPos.y]);

  const onPipPointerMove = useCallback((e) => {
    const drag = pipDragRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    // Get the PiP element size from the event target's parent (the .pip wrapper)
    const pipEl = e.currentTarget;
    const pipW = pipEl.offsetWidth;
    const pipH = pipEl.offsetHeight;

    // Clamp so the PiP stays fully inside the container
    const maxX = drag.containerW - pipW;
    const maxY = drag.containerH - pipH;

    let newX = drag.origX + dx;
    let newY = drag.origY + dy;

    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    setPipPos({ x: newX, y: newY });
  }, []);

  const onPipPointerUp = useCallback((e) => {
    pipDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const togglePipFit = useCallback(() => {
    setPipFit((prev) => (prev === "cover" ? "contain" : "cover"));
  }, []);

  // Initialize the PiP position to the top-right corner once the stage is
  // rendered. We use a ref-callback on the container to measure it, then set
  // the position accounting for the PiP width and a margin.
  const onPipContainerRef = useCallback((node) => {
    pipContainerRef.current = node;
    if (node && pipPos.x === 0 && pipPos.y === 0) {
      // Defer measurement until after the layout settles.
      requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const pipW = node.querySelector(".pip-wrapper")?.offsetWidth ?? 130;
        setPipPos({
          x: rect.width - pipW - 16,
          y: 16,
        });
      });
    }
  }, [pipPos.x, pipPos.y]);

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
          <p className="subtitle">
            Start a video call instantly. Create a room and share the ID, or
            join an existing room.
          </p>

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

      {/* ── Full-screen remote video stage ──────────────────────────────────
          The remote participant is the main full-screen video. The local
          camera floats on top as a draggable PiP overlay. */}
      <section
        className="video-stage"
        ref={onPipContainerRef}
      >
        {/* Remote video — full width and height of the stage */}
        <div className="remote-video-wrapper">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="video-element remote-video"
          />
          {connectionState !== "connected" && (
            <div className="video-placeholder remote-placeholder">
              <p>
                {connectionState === "connecting"
                  ? "Connecting…"
                  : connectionState === "failed"
                  ? "Connection failed"
                  : participantJoined
                  ? "Remote participant"
                  : "Waiting for another participant…"}
              </p>
            </div>
          )}
          <div className="video-label remote-label">Remote participant</div>
        </div>

        {/* Local camera — floating draggable PiP overlay */}
        {/* Position is applied via inline style from state so it updates on
            every drag move. The initial position is set by the CSS default
            (top-right) until the first drag, but we initialize pipPos in the
            effect below to match the rendered default. */}
        <div
          className="pip-wrapper"
          style={{
            transform: `translate(${pipPos.x}px, ${pipPos.y}px)`,
          }}
          onPointerDown={onPipPointerDown}
          onPointerMove={onPipPointerMove}
          onPointerUp={onPipPointerUp}
          onPointerCancel={onPipPointerUp}
        >
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="video-element pip-video"
            style={{ objectFit: pipFit }}
          />
          <div className="pip-label">{CAMERA_LABEL}</div>
          <button
            className="pip-toggle-fit"
            onClick={togglePipFit}
            aria-label="Toggle video fit"
            title={pipFit === "cover" ? "Switch to Fit" : "Switch to Cover"}
          >
            {pipFit === "cover" ? "⤢" : "⤡"}
          </button>
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
          <span
            className={`status-dot ${participantJoined ? "connected" : ""}`}
          />
          {participantJoined ? "Participant joined" : "Waiting for participant"}
        </div>

        <div className="call-controls">
          <button
            className={`control-button mic-button ${isMicMuted ? "muted" : ""}`}
            onClick={toggleMic}
            aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
            disabled={!hasLocalStream}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden="true">
              {isMicMuted ? (
                <>
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                  <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                </>
              ) : (
                <>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </>
              )}
            </svg>
            {isMicMuted ? "Unmute" : "Mute"}
          </button>

          <button
            className={`control-button camera-button ${isCameraOff ? "off" : ""}`}
            onClick={toggleCamera}
            aria-label={isCameraOff ? "Turn on camera" : "Turn off camera"}
            disabled={!hasLocalStream}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden="true">
              {isCameraOff ? (
                <>
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34" />
                </>
              ) : (
                <>
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </>
              )}
            </svg>
            {isCameraOff ? "On" : "Off"}
          </button>

          <button
            className="control-button end-call-button"
            onClick={endCall}
            aria-label="End call"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden="true">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
              <line x1="23" y1="1" x2="1" y2="23" />
            </svg>
            End Call
          </button>
        </div>

        <p className="message">{message}</p>
      </section>
    </main>
  );
}

export default VideoScreen;
