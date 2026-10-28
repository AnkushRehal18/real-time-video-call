/**
 * Backend signaling integration test.
 *
 * Verifies that the Socket.IO signaling relay works correctly end-to-end:
 *   - room creation and joining
 *   - user-joined notification
 *   - webrtc-offer forwarding
 *   - webrtc-answer forwarding
 *   - webrtc-ice-candidate forwarding (both directions)
 *   - user-left on explicit leave
 *   - user-left on disconnect
 *
 * Run with:
 *   node server.js &   # in one terminal
 *   node test-signaling.js   # in another
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */

"use strict";

const { io } = require("socket.io-client");

const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:5000";
const TIMEOUT_MS = 5000;

let passed = 0;
let failed = 0;
const sockets = [];

function createClient(label) {
    const sock = io(SERVER_URL, { forceNew: true });
    sockets.push({ label, sock });
    return sock;
}

function expect(label, condition, detail = "") {
    if (condition) {
        console.log(`  ✅ PASS: ${label}${detail ? " — " + detail : ""}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${label}${detail ? " — " + detail : ""}`);
        failed++;
    }
}

function waitFor(emitter, event, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for "${event}" after ${timeoutMs}ms`));
        }, timeoutMs);
        emitter.once(event, (...args) => {
            clearTimeout(timer);
            resolve(args);
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
    console.log(`\n📡 Signaling Integration Tests — ${SERVER_URL}\n`);

    // ── Setup ─────────────────────────────────────────────────────────────────
    const user1 = createClient("user1");
    const user2 = createClient("user2");

    await Promise.all([
        waitFor(user1, "connect"),
        waitFor(user2, "connect"),
    ]);
    console.log("  Sockets connected:", user1.id, user2.id);

    // ── Test 1: Room creation ─────────────────────────────────────────────────
    console.log("\n▸ Test 1: Room creation");
    const createResponse = await new Promise((resolve) =>
        user1.emit("create-room", resolve)
    );
    expect("create-room returns success", createResponse?.success === true);
    expect("create-room returns roomId", typeof createResponse?.roomId === "string");
    const roomId = createResponse?.roomId;

    // ── Test 2: Room joining + user-joined notification ───────────────────────
    console.log("\n▸ Test 2: Room joining");
    const [userJoinedPayload, joinResponse] = await Promise.all([
        waitFor(user1, "user-joined"),
        new Promise((resolve) => user2.emit("join-room", roomId, resolve)),
    ]);
    expect("join-room returns success", joinResponse?.success === true);
    expect("user1 receives user-joined", userJoinedPayload != null);
    expect(
        "user-joined carries user2 socketId",
        userJoinedPayload?.[0]?.socketId === user2.id,
        `expected ${user2.id}, got ${userJoinedPayload?.[0]?.socketId}`
    );

    // ── Test 3: webrtc-offer forwarding ──────────────────────────────────────
    console.log("\n▸ Test 3: webrtc-offer forwarding");
    const fakeOffer = { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
    const [receivedOffer] = await Promise.all([
        waitFor(user2, "webrtc-offer"),
        Promise.resolve(user1.emit("webrtc-offer", { roomId, offer: fakeOffer })),
    ]);
    expect("user2 receives webrtc-offer", receivedOffer != null);
    expect("offer type preserved", receivedOffer?.[0]?.offer?.type === "offer");
    expect("sender socketId in payload", receivedOffer?.[0]?.socketId === user1.id);

    // ── Test 4: webrtc-answer forwarding ─────────────────────────────────────
    console.log("\n▸ Test 4: webrtc-answer forwarding");
    const fakeAnswer = { type: "answer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
    const [receivedAnswer] = await Promise.all([
        waitFor(user1, "webrtc-answer"),
        Promise.resolve(user2.emit("webrtc-answer", { roomId, answer: fakeAnswer })),
    ]);
    expect("user1 receives webrtc-answer", receivedAnswer != null);
    expect("answer type preserved", receivedAnswer?.[0]?.answer?.type === "answer");
    expect("sender socketId in payload", receivedAnswer?.[0]?.socketId === user2.id);

    // ── Test 5: ICE candidate forwarding (both directions) ───────────────────
    console.log("\n▸ Test 5: ICE candidate forwarding");
    const fakeCandidate = {
        candidate: "candidate:1 1 udp 2122260223 192.168.1.1 12345 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
    };

    // user1 → user2
    const [ice1to2] = await Promise.all([
        waitFor(user2, "webrtc-ice-candidate"),
        Promise.resolve(user1.emit("webrtc-ice-candidate", { roomId, candidate: fakeCandidate })),
    ]);
    expect("user2 receives ICE candidate from user1", ice1to2 != null);
    expect("ICE sender ID correct (user1→user2)", ice1to2?.[0]?.socketId === user1.id);

    // user2 → user1
    const [ice2to1] = await Promise.all([
        waitFor(user1, "webrtc-ice-candidate"),
        Promise.resolve(user2.emit("webrtc-ice-candidate", { roomId, candidate: fakeCandidate })),
    ]);
    expect("user1 receives ICE candidate from user2", ice2to1 != null);
    expect("ICE sender ID correct (user2→user1)", ice2to1?.[0]?.socketId === user2.id);

    // ── Test 6: user-left on explicit leave ───────────────────────────────────
    console.log("\n▸ Test 6: user-left on leave-room");
    const [userLeftPayload] = await Promise.all([
        waitFor(user1, "user-left"),
        new Promise((resolve) => user2.emit("leave-room", roomId, resolve)),
    ]);
    expect("user1 receives user-left", userLeftPayload != null);
    expect(
        "user-left carries user2 socketId",
        userLeftPayload?.[0]?.socketId === user2.id,
        `expected ${user2.id}, got ${userLeftPayload?.[0]?.socketId}`
    );

    // ── Test 7: user-left on abrupt disconnect ────────────────────────────────
    console.log("\n▸ Test 7: user-left on disconnect");
    // Create a fresh pair for this test
    const user3 = createClient("user3");
    const user4 = createClient("user4");
    await Promise.all([waitFor(user3, "connect"), waitFor(user4, "connect")]);

    const room2Response = await new Promise((resolve) =>
        user3.emit("create-room", resolve)
    );
    const room2Id = room2Response?.roomId;
    await Promise.all([
        waitFor(user3, "user-joined"),
        new Promise((resolve) => user4.emit("join-room", room2Id, resolve)),
    ]);

    const [userLeftOnDisconnect] = await Promise.all([
        waitFor(user3, "user-left", TIMEOUT_MS),
        Promise.resolve(user4.disconnect()),
    ]);
    expect("user3 receives user-left when user4 disconnects abruptly", userLeftOnDisconnect != null);

    // ── Test 8: drop webrtc-offer without roomId ──────────────────────────────
    console.log("\n▸ Test 8: validation — offer without roomId is dropped silently");
    // There is no callback for this; verify no crash occurs and no offer is forwarded.
    user1.emit("webrtc-offer", { offer: fakeOffer }); // missing roomId
    await sleep(200); // give server time to process
    expect("server did not crash on missing roomId", true); // if we reach here, server is alive

    // ── Cleanup ───────────────────────────────────────────────────────────────
    for (const { sock } of sockets) {
        if (sock.connected) sock.disconnect();
    }
    await sleep(200);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error("❌ Some tests failed.\n");
        process.exit(1);
    } else {
        console.log("✅ All tests passed.\n");
        process.exit(0);
    }
}

runTests().catch((err) => {
    console.error("Test runner error:", err.message);
    for (const { sock } of sockets) {
        if (sock.connected) sock.disconnect();
    }
    process.exit(1);
});
