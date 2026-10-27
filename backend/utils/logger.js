/**
 * Centralized Winston logger for the video call backend.
 *
 * Behaviour:
 *  - Development  (NODE_ENV !== 'production'): colorized, human-readable output to stdout.
 *  - Production   (NODE_ENV === 'production') : structured JSON to stdout so Render can index it.
 *  - Minimum log level is controlled by LOG_LEVEL; defaults to "debug" in dev, "info" in prod.
 *  - Logging failures are caught internally and never crash the process.
 */

"use strict";

const { createLogger, format, transports } = require("winston");

const { combine, timestamp, errors, json, colorize, printf, splat } = format;

const isProduction = process.env.NODE_ENV === "production";

// ── Log level ────────────────────────────────────────────────────────────────
const level = process.env.LOG_LEVEL || (isProduction ? "info" : "debug");

// ── Sanitise a string to prevent newline-injection into logs ─────────────────
const sanitize = (value) => {
  if (typeof value !== "string") return value;
  return value.replace(/[\r\n]+/g, " ").trim();
};

// ── Development format: coloured, single-line, human-readable ────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
  errors({ stack: true }),
  splat(),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const msg = sanitize(String(message));
    const metaStr = Object.keys(meta).length
      ? " " + JSON.stringify(meta)
      : "";
    const stackStr = stack ? `\n${stack}` : "";
    return `${timestamp} [${level}] ${msg}${metaStr}${stackStr}`;
  })
);

// ── Production format: structured JSON ───────────────────────────────────────
const prodFormat = combine(
  timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
  errors({ stack: true }),
  splat(),
  // Sanitise the message field before serialising
  format((info) => {
    if (info.message) info.message = sanitize(String(info.message));
    return info;
  })(),
  json()
);

// ── Transport: always write to stdout/stderr ──────────────────────────────────
const consoleTransport = new transports.Console({
  handleExceptions: false, // we handle process-level errors in server.js
  handleRejections: false,
  format: isProduction ? prodFormat : devFormat,
});

// ── Create the logger ─────────────────────────────────────────────────────────
const logger = createLogger({
  level,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
  },
  transports: [consoleTransport],
  // Prevent unhandled exceptions inside Winston from crashing the app
  exitOnError: false,
});

module.exports = logger;
