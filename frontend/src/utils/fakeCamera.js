
export function createFakeCamera() {
  const canvas = document.createElement("canvas");

  canvas.width = 640;
  canvas.height = 480;

  const ctx = canvas.getContext("2d");

  if (!ctx || typeof canvas.captureStream !== "function") {
    throw new Error("Canvas video streaming is not supported by this browser.");
  }

  let frame = 0;
  let animationId = null;
  let stopped = false;
  let paused = false;

  function drawFrame() {
    if (stopped || paused) return;

    ctx.fillStyle = "#101827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const x = 320 + Math.sin(frame * 0.04) * 180;
    const y = 240 + Math.cos(frame * 0.04) * 100;

    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(x, y, 55, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "white";
    ctx.font = "28px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Simulated Camera", 320, 60);

    frame++;
    animationId = requestAnimationFrame(drawFrame);
  }

  drawFrame();

  const stream = canvas.captureStream(24);

  // Stop the animation and media tracks when finished.
  stream.stopCamera = () => {
    stopped = true;

    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    stream.getTracks().forEach((track) => track.stop());
  };

  // Pause/resume animation when video track is toggled
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    const originalEnabled = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(videoTrack),
      "enabled"
    );

    Object.defineProperty(videoTrack, "enabled", {
      get() {
        return originalEnabled?.get.call(this);
      },
      set(value) {
        originalEnabled?.set.call(this, value);
        if (!value) {
          // Track disabled - pause animation
          paused = true;
          if (animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
          }
        } else {
          // Track enabled - resume animation
          paused = false;
          if (!stopped && animationId === null) {
            drawFrame();
          }
        }
      },
    });
  }

  return stream;
}
