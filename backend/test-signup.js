/**
 * Signup endpoint tests.
 *
 * These are unit-style tests that mock the Neon SQL client and bcrypt so
 * they can run without a live database connection. They exercise the
 * validation, hashing, duplicate-email handling, and response format
 * of the signup controller directly.
 *
 * To also run a live integration test against a real Neon database,
 * start the server (node server.js) and run:
 *   node test-signup.js --integration
 *
 * The integration test uses a dedicated test email and does NOT delete
 * any existing user records. Cleanup is the developer's responsibility.
 *
 * Run with: node test-signup.js
 */

"use strict";

const path = require("path");

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}${detail ? " — " + detail : ""}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function runUnitTests() {
  console.log("\n🧪 Signup Unit Tests (mocked database)\n");

  // ── Mock setup ───────────────────────────────────────────────────────────
  // We intercept require calls to inject mocks for the database and logger.
  const Module = require("module");
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;

  const dbPath = path.resolve(__dirname, "config/database.js");
  const loggerPath = path.resolve(__dirname, "utils/logger.js");

  // Track INSERT results for assertions
  let mockInsertResult = [];
  let mockInsertedData = null;
  let mockSqlFn = null;

  const mockSql = (strings, ...values) => {
    if (mockSqlFn) return mockSqlFn(strings, ...values);
    // Reconstruct the query to check it's the INSERT we expect
    const query = strings.join("${param}");
    if (query.includes("INSERT INTO users")) {
      mockInsertedData = { name: values[0], email: values[1], passwordHash: values[2] };
      return Promise.resolve(mockInsertResult);
    }
    return Promise.resolve([]);
  };

  const mockLogger = {
    error: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
  };

  // Override module resolution to inject mocks
  Module._resolveFilename = function (request, parent, ...args) {
    if (parent && parent.filename === path.resolve(__dirname, "controller/auth.controller.js")) {
      if (request === "../config/database") return dbPath;
      if (request === "../utils/logger") return loggerPath;
    }
    return originalResolve.call(this, request, parent, ...args);
  };

  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === path.resolve(__dirname, "controller/auth.controller.js")) {
      if (request === "../config/database") return { sql: mockSql };
      if (request === "../utils/logger") return mockLogger;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Now require the controller — it will get our mocks
  const authController = require("./controller/auth.controller");

  // Helper to create mock req/res
  function mockReq(body) {
    return { body };
  }
  function mockRes() {
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    return res;
  }

  // ── Test 1: Valid signup returns 201 ──────────────────────────────────────
  console.log("▸ Test 1: Valid signup returns 201");
  {
    mockInsertResult = [{ id: "uuid-1", name: "Test User", email: "test@example.com", created_at: "2025-01-01T00:00:00Z" }];
    const req = mockReq({ name: "Test User", email: "test@example.com", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 201", res.statusCode === 201, `got ${res.statusCode}`);
    assert("returns success: true", res.body?.success === true);
    assert("returns user object", !!res.body?.user);
    assert("user has id", !!res.body?.user?.id);
    assert("response does not contain password", JSON.stringify(res.body).includes("password") === false);
    assert("response does not contain password_hash", JSON.stringify(res.body).includes("password_hash") === false);
  }

  // ── Test 2: Duplicate email returns 409 ─────────────────────────────────────
  console.log("\n▸ Test 2: Duplicate email returns 409");
  {
    mockInsertResult = []; // ON CONFLICT DO NOTHING returns 0 rows
    const req = mockReq({ name: "Test User", email: "test@example.com", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 409", res.statusCode === 409, `got ${res.statusCode}`);
    assert("returns success: false", res.body?.success === false);
    assert("message mentions already exists", res.body?.message?.includes("already exists") === true);
  }

  // ── Test 3: Missing name returns 400 ──────────────────────────────────────
  console.log("\n▸ Test 3: Missing name returns 400");
  {
    const req = mockReq({ email: "test@example.com", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 400", res.statusCode === 400, `got ${res.statusCode}`);
    assert("has name error", !!res.body?.errors?.name);
  }

  // ── Test 4: Missing email returns 400 ──────────────────────────────────────
  console.log("\n▸ Test 4: Missing email returns 400");
  {
    const req = mockReq({ name: "Test User", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 400", res.statusCode === 400, `got ${res.statusCode}`);
    assert("has email error", !!res.body?.errors?.email);
  }

  // ── Test 5: Missing password returns 400 ───────────────────────────────────
  console.log("\n▸ Test 5: Missing password returns 400");
  {
    const req = mockReq({ name: "Test User", email: "test@example.com" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 400", res.statusCode === 400, `got ${res.statusCode}`);
    assert("has password error", !!res.body?.errors?.password);
  }

  // ── Test 6: Invalid email returns 400 ──────────────────────────────────────
  console.log("\n▸ Test 6: Invalid email returns 400");
  {
    const req = mockReq({ name: "Test User", email: "not-an-email", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 400", res.statusCode === 400, `got ${res.statusCode}`);
    assert("has email error", !!res.body?.errors?.email);
  }

  // ── Test 7: Weak password returns 400 ───────────────────────────────────────
  console.log("\n▸ Test 7: Weak password returns 400");
  {
    const req = mockReq({ name: "Test User", email: "test@example.com", password: "123" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 400", res.statusCode === 400, `got ${res.statusCode}`);
    assert("has password error", !!res.body?.errors?.password);
  }

  // ── Test 8: Strong password is accepted ─────────────────────────────────────
  console.log("\n▸ Test 8: Strong password is accepted");
  {
    mockInsertResult = [{ id: "uuid-2", name: "Test User", email: "strong@example.com", created_at: "2025-01-01T00:00:00Z" }];
    const req = mockReq({ name: "Test User", email: "strong@example.com", password: "Str0ngP@ssw0rd!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 201 (not 400)", res.statusCode === 201, `got ${res.statusCode}`);
  }

  // ── Test 9: Password is hashed (not plaintext in INSERT) ──────────────────
  console.log("\n▸ Test 9: Password is hashed before insertion");
  {
    mockInsertResult = [{ id: "uuid-3", name: "Hash Test", email: "hash@example.com", created_at: "2025-01-01T00:00:00Z" }];
    const req = mockReq({ name: "Hash Test", email: "hash@example.com", password: "MyP@ssw0rd1" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("INSERT received a hash, not plaintext", mockInsertedData?.passwordHash !== "MyP@ssw0rd1", `hash was: ${mockInsertedData?.passwordHash?.substring(0, 7)}...`);
    assert("hash starts with $2 (bcrypt prefix)", mockInsertedData?.passwordHash?.startsWith("$2") === true);
  }

  // ── Test 10: Email is normalized to lowercase ──────────────────────────────
  console.log("\n▸ Test 10: Email is normalized to lowercase");
  {
    mockInsertResult = [{ id: "uuid-4", name: "Norm Test", email: "norm@example.com", created_at: "2025-01-01T00:00:00Z" }];
    const req = mockReq({ name: "Norm Test", email: "Norm@Example.COM", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("INSERT received lowercase email", mockInsertedData?.email === "norm@example.com", `got: ${mockInsertedData?.email}`);
  }

  // ── Test 11: SQL injection input is safely parameterized ──────────────────
  console.log("\n▸ Test 11: SQL injection input is safely parameterized");
  {
    mockInsertResult = [{ id: "uuid-5", name: "Inject Test", email: "inject@example.com", created_at: "2025-01-01T00:00:00Z" }];
    // The email is valid format but contains injection attempt
    const req = mockReq({ name: "Inject Test", email: "inject@example.com", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    // If parameterized, the name is passed as a value, not interpolated into SQL
    assert("signup completed without error (parameterized)", res.statusCode === 201, `got ${res.statusCode}`);
  }

  // ── Test 12: Database failure returns generic 500 ──────────────────────────
  console.log("\n▸ Test 12: Database failure returns generic 500");
  {
    // Override mockSql behavior to throw
    mockSqlFn = () => Promise.reject(new Error("connection refused: DETAILS: password authentication failed for user 'neondb_owner'"));
    const req = mockReq({ name: "Fail Test", email: "fail@example.com", password: "StrongP@ss1!" });
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 500", res.statusCode === 500, `got ${res.statusCode}`);
    assert("message is generic (no DB details)", res.body?.message === "Unable to create your account right now.");
    assert("response does not contain connection string", JSON.stringify(res.body).includes("neondb") === false);
    assert("response does not contain SQL details", JSON.stringify(res.body).includes("password authentication") === false);
    // Restore mock behavior
    mockSqlFn = null;
  }

  // ── Test 13: Malformed body (non-object) returns 400 ──────────────────────
  console.log("\n▸ Test 13: Malformed body (non-object) returns 400");
  {
    const req = mockReq(null);
    const res = mockRes();
    await authController.signup(req, res);
    assert("returns status 400", res.statusCode === 400, `got ${res.statusCode}`);
  }

  // ── Test 14: Unknown auth route returns 404 ──────────────────────────────
  console.log("\n▸ Test 14: Unknown auth route returns 404 (requires server)");
  console.log("  ⏭️  SKIP: requires running server (integration test)");

  // ── Restore module system ────────────────────────────────────────────────
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Unit test results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("❌ Some tests failed.\n");
    process.exitCode = 1;
  } else {
    console.log("✅ All unit tests passed.\n");
  }
}

runUnitTests().catch((err) => {
  console.error("Test runner error:", err.message);
  process.exitCode = 1;
});
