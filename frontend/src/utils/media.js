import { createFakeCamera } from "./fakeCamera";

/**
 * Gets the appropriate media stream based on the environment mode
 * - Development mode: Uses simulated camera (Canvas API)
 * - Production mode: Requests real camera and microphone
 * 
 * @returns {Promise<MediaStream>} The media stream
 * @throws {Error} If media acquisition fails
 */
export async function getMediaStream() {
  const isProduction = import.meta.env.MODE === "production";

  if (isProduction) {
    // Production mode: Request real camera and microphone
    try {
      console.log("[Media] Requesting real camera and microphone in production mode");
      
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Browser does not support mediaDevices.getUserMedia");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      console.log("[Media] Real camera and microphone acquired, tracks:", stream.getTracks().length);
      return stream;
    } catch (error) {
      console.error("[Media] Failed to acquire real media:", error);
      
      // Provide user-friendly error messages
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        throw new Error("Camera and microphone permission denied. Please allow access in your browser settings.");
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        throw new Error("No camera or microphone found. Please connect a device and try again.");
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        throw new Error("Camera or microphone is already in use by another application.");
      } else if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
        throw new Error("Camera does not support the requested constraints.");
      } else {
        throw new Error(`Failed to access camera and microphone: ${error.message}`);
      }
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
