"use strict";

const { sql } = require("../config/database");
const logger = require("../utils/logger");
const validationService = require("../utils/validation");
const bcrypt = require("bcrypt");

/**
 * POST /api/auth/signup
 *
 * Creates a new user account. Validates input, normalizes email to lowercase,
 * hashes the password with bcrypt, and inserts into the users table using a
 * parameterized Neon SQL query. Duplicate emails are handled atomically via
 * PostgreSQL's ON CONFLICT clause.
 *
 * Response codes:
 *   201 — account created, returns safe user fields (id, name, email, created_at)
 *   400 — validation error (missing/invalid name, email, or password)
 *   409 — email already registered
 *   500 — unexpected server/database error (generic message, no internals leaked)
 */
exports.signup = async (req, res) => {
  try {
    // Guard against non-object bodies (e.g. raw strings, arrays, null)
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: "Validation error.",
        errors: { body: ["Request body must be a JSON object."] },
      });
    }

    // Sanitize input — name and email are trimmed + escaped, password is
    // trimmed only (never HTML-escaped, since it is hashed as-is).
    const sanitizedData = validationService.sanitizeObject(req.body);

    // Validate the sanitized data
    const validationError = validationService.validateSignupData(sanitizedData);
    if (validationError) {
      return res.status(400).json(validationError);
    }

    const { name, email, password } = sanitizedData;

    // Normalize email to lowercase before insertion so that the UNIQUE
    // constraint treats "User@Example.com" and "user@example.com" as the same.
    const normalizedEmail = email.trim().toLowerCase();

    // Hash the original (validated, trimmed) password string with bcrypt.
    // 12 rounds is a reasonable cost factor for production.
    const passwordHash = await bcrypt.hash(password, 12);

    // Parameterized Neon SQL query — values are passed safely, preventing
    // SQL injection. ON CONFLICT (email) DO NOTHING returns 0 rows on duplicate,
    // which we map to a 409 response.
    const users = await sql`
      INSERT INTO users (name, email, password_hash)
      VALUES (${name}, ${normalizedEmail}, ${passwordHash})
      ON CONFLICT (email) DO NOTHING
      RETURNING id, name, email, created_at
    `;

    if (users.length === 0) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    // Return only safe user fields — never include password or password_hash
    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: users[0],
    });
  } catch (err) {
    // Log the full error internally for debugging, but return a generic
    // message to the client so SQL details, stack traces, or connection
    // strings are never exposed.
    logger.error("Signup failed", { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: "Unable to create your account right now.",
    });
  }
};
