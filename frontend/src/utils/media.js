import { createFakeCamera } from "./fakeCamera";

/**
 * Gets the appropriate media stream based on the environment mode
 * - Development mode: Uses simulated camera (Canvas API)
 * - Production mode: Requests real camera and microphone
 * 
 * Returns null if media acquisition fails, allowing receive-only WebRTC connections
 * 
 * @returns {Promise<MediaStream|null>} The media stream, or null if acquisition fails
 */
export async function getMediaStream() {
  const isProduction = import.meta.env.MODE === "production";

  if (isProduction) {
    // Production mode: Request real camera and microphone
    try {
      console.log("[Media] Requesting real camera and microphone in production mode");
      
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("[Media] Browser does not support mediaDevices.getUserMedia");
        return null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      console.log("[Media] Real camera and microphone acquired, tracks:", stream.getTracks().length);
      return stream;
    } catch (error) {
      console.error("[Media] Failed to acquire real media:", error);
      
      // Return null instead of throwing to allow receive-only mode
      // The UI will show the specific error message
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
      
      console.warn("[Media]", errorMessage);
      // Store error message in a way that can be retrieved by the component
      throw new Error(errorMessage, { cause: error });
    }
  } else {
    // Development mode: Use simulated camera
    console.log("[Media] Using simulated camera in development mode");
    const stream = createFakeCamera();
    console.log("[Media] Simulated camera acquired, tracks:", stream.getTracks().length);
    return stream;
  }
}

/**
 * Stops a media stream and cleans up resources
 * Handles both real media streams and simulated camera streams
 * 
 * @param {MediaStream} stream - The stream to stop
 */
export function stopMediaStream(stream) {
  if (!stream) return;

  // Stop all media tracks
  stream.getTracks().forEach((track) => {
    track.stop();
    console.log("[Media] Stopped track:", track.kind);
  });

  // If it's a simulated camera with custom cleanup, call it
  if (typeof stream.stopCamera === "function") {
    stream.stopCamera();
    console.log("[Media] Called custom stopCamera cleanup");
  }
}

/**
 * Checks if the current mode is production
 * 
 * @returns {boolean} True if in production mode
 */
export function isProductionMode() {
  return import.meta.env.MODE === "production";
}

/**
 * Gets the appropriate label for the local video based on mode
 * 
 * @returns {string} "Camera" for production, "Simulated Camera" for development
 */
export function getCameraLabel() {
  return isProductionMode() ? "Camera" : "Simulated Camera";
}
