import { createFakeCamera } from "./fakeCamera";

/**
 * Gets the appropriate media stream based on the environment mode.
 *  - Development mode: Uses simulated camera (Canvas API).
 *  - Production mode:  Requests real camera and microphone.
 *
 * Always resolves — returns null if media acquisition fails so the caller can
 * continue in receive-only WebRTC mode. Does NOT throw; error details are
 * returned via the errorMessage property on the returned null (see below).
 *
 * @returns {Promise<MediaStream|null>} The media stream, or null on failure.
 */
export async function getMediaStream() {
  const isProduction = import.meta.env.MODE === "production";

  if (isProduction) {
    // Production mode: Request real camera and microphone
    try {
      console.log("[LocalMedia] requesting real camera and microphone (production)");

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("[LocalMedia] browser does not support mediaDevices.getUserMedia");
        return null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      console.log("[LocalMedia] real camera and microphone acquired", {
        trackCount: stream.getTracks().length,
        tracks: stream.getTracks().map((t) => ({
          kind: t.kind,
          readyState: t.readyState,
          enabled: t.enabled,
        })),
      });
      return stream;
    } catch (error) {
      // FIX (Bug 3): Return null instead of re-throwing. The JSDoc contract
      // says this function returns null on failure. Re-throwing was an
      // inconsistency that forced callers to handle two code paths (catch +
      // null check). Now callers only need to check for null.
      let errorMessage;
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorMessage = "Camera and microphone permission denied. You can still receive remote video.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorMessage = "No camera or microphone found. You can still receive remote video.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorMessage = "Camera or microphone is already in use. You can still receive remote video.";
      } else if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
        errorMessage = "Camera does not support the requested constraints. You can still receive remote video.";
      } else {
        errorMessage = `Failed to access camera and microphone: ${error.message}. You can still receive remote video.`;
      }

      console.error("[LocalMedia] media acquisition failed:", {
        name: error.name,
        message: errorMessage,
      });

      // Attach the user-facing message to a property on null so the caller
      // (videScreen.jsx acquireMedia) can display the specific reason.
      const result = null;
      // We use a module-level variable so callers can read it after null return.
      getMediaStream._lastErrorMessage = errorMessage;
      return result;
    }
  } else {
    // Development mode: Use simulated camera
    console.log("[LocalMedia] using simulated camera (development)");
    const stream = createFakeCamera();
    console.log("[LocalMedia] simulated camera acquired", {
      trackCount: stream.getTracks().length,
    });
    return stream;
  }
}

/**
 * Returns the error message from the most recent failed getMediaStream() call,
 * or null if the last call succeeded.
 *
 * @returns {string|null}
 */
export function getLastMediaError() {
  return getMediaStream._lastErrorMessage ?? null;
}

// Initialise the static property
getMediaStream._lastErrorMessage = null;

/**
 * Stops a media stream and cleans up resources.
 * Handles both real media streams and simulated camera streams.
 *
 * @param {MediaStream} stream - The stream to stop
 */
export function stopMediaStream(stream) {
  if (!stream) return;

  // Stop all media tracks
  stream.getTracks().forEach((track) => {
    track.stop();
    console.log("[LocalMedia] stopped track:", track.kind);
  });

  // If it's a simulated camera with custom cleanup, call it
  if (typeof stream.stopCamera === "function") {
    stream.stopCamera();
    console.log("[LocalMedia] called custom stopCamera cleanup");
  }
}

/**
 * Checks if the current mode is production.
 *
 * @returns {boolean} True if in production mode
 */
export function isProductionMode() {
  return import.meta.env.MODE === "production";
}

/**
 * Gets the appropriate label for the local video based on mode.
 *
 * @returns {string} "Camera" for production, "Simulated Camera" for development
 */
export function getCameraLabel() {
  return isProductionMode() ? "Camera" : "Simulated Camera";
}
