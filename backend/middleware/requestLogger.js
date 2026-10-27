/**
 * HTTP request logging middleware.
 *
 * Logs method, path (query params stripped), status code, duration, and a
 * per-request correlation ID.  Sensitive headers (Authorization, Cookie,
 * Set-Cookie) are never logged.
 */

"use strict";

const { randomUUID } = require("crypto");
const logger = require("../utils/logger");

// Paths we intentionally skip logging (e.g. frequent health-check noise in prod)
const SILENT_PATHS = new Set([]);

/**
 * Strip query parameters from a URL path to avoid logging tokens or PII that
 * might appear in query strings.
 */
const stripQuery = (url = "") => {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
};

/**
 * Sanitise a request ID supplied by a client proxy (e.g. X-Request-Id).
 * Accept only UUID-like strings; fall back to a freshly generated UUID.
 */
const safeRequestId = (header) => {
  if (typeof header === "string" && /^[\w\-]{8,64}$/.test(header)) {
    return header.slice(0, 64); // cap length
  }
  return randomUUID();
};

const requestLogger = (req, res, next) => {
  const path = stripQuery(req.url || req.path || "");

  if (SILENT_PATHS.has(path)) {
    return next();
  }

  req.requestId = safeRequestId(req.headers["x-request-id"]);
  const startAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1e6;

    const logData = {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: parseFloat(durationMs.toFixed(2)),
    };

    const level = res.statusCode >= 500 ? "error" : "http";
    logger[level]("HTTP request completed", logData);
  });

  // Log 5xx errors with the error details if the response carries one
  res.on("error", (err) => {
    logger.error("HTTP response stream error", {
      requestId: req.requestId,
      method: req.method,
      path,
      error: err.message,
      stack: err.stack,
    });
  });

  next();
};

/**
 * Express error-handling middleware.
 * Logs unhandled errors then forwards them so Express can send the response.
 */
const errorLogger = (err, req, res, next) => {
  logger.error("Unhandled request error", {
    requestId: req.requestId,
    method: req.method,
    path: stripQuery(req.url || req.path || ""),
    error: err.message,
    stack: err.stack,
    status: err.status || err.statusCode || 500,
  });
  next(err);
};

module.exports = { requestLogger, errorLogger };
