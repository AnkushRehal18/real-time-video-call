"use strict";

const express = require("express");
const http = require("http");
const cors = require("cors");

const { config } = require("./config/config");
const logger = require("./utils/logger");
const { requestLogger, errorLogger } = require("./middleware/requestLogger");
const healthRouter = require("./routes/health.route");
const authRouter = require("./routes/auth.route");
const initializeSocket = require("./utils/socket");

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Body parsing — must run before any route that reads req.body
app.use(express.json());

// CORS — restrict to the configured frontend origin, never unrestricted.
// Credentials are not enabled since this endpoint does not use cookies/sessions.
const corsOrigin = process.env.FRONTEND_URL || "http://localhost:5173";
app.use(cors({ origin: corsOrigin, methods: ["GET", "POST"] }));

// HTTP request logging (before routes so every request is captured)
app.use(requestLogger);

// API routes
app.use(healthRouter);
app.use("/api/auth", authRouter);

// Error logging (after routes, before Express default error handler)
app.use(errorLogger);

// ── HTTP + Socket.IO server ───────────────────────────────────────────────────
const server = http.createServer(app);

logger.info("Initializing Socket.IO");
initializeSocket(server);
logger.info("Socket.IO initialized successfully");

// ── Start listening ───────────────────────────────────────────────────────────
server.listen(config.server.port, () => {
  logger.info("Server started", {
    port: config.server.port,
    env: config.server.nodeEnv || "development",
  });
});

server.on("error", (err) => {
  logger.error("HTTP server error", { error: err.message, stack: err.stack });
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = (signal) => {
  logger.info("Graceful shutdown initiated", { signal });

  server.close((err) => {
    if (err) {
      logger.error("Error during server shutdown", {
        error: err.message,
        stack: err.stack,
      });
      process.exit(1);
    }
    logger.info("Shutdown complete");
    process.exit(0);
  });

  // Force-exit after 10 s if connections are not drained
  setTimeout(() => {
    logger.warn("Forcing shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Process-level safety net ──────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error("Unhandled promise rejection", { error: message, stack });
  // Do not exit; the rejection may be isolated and the server can continue.
});

process.on("uncaughtException", (err) => {
  // An uncaught exception leaves the process in an undefined state.
  // Log and exit so the process manager (Render) can restart cleanly.
  logger.error("Uncaught exception – shutting down", {
    error: err.message,
    stack: err.stack,
  });
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5_000).unref();
});
