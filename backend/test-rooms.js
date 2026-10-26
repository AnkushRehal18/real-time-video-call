
const { io } = require("socket.io-client");

const SERVER_URL = "http://localhost:5000";

const user1 = io(SERVER_URL);
const user2 = io(SERVER_URL);

user1.on("connect", () => {
  console.log("User 1 connected:", user1.id);

  // User 1 creates a room
  user1.emit("create-room", (response) => {
    console.log("Room creation response:", response);

    if (!response?.success) {
      console.log("Room creation failed");
      user1.disconnect();
      user2.disconnect();
      return;
    }

    const roomId = response.roomId;

    // User 2 joins the room created by User 1
    user2.on("connect", () => {
      console.log("User 2 connected:", user2.id);

      user2.emit("join-room", roomId, (joinResponse) => {
        console.log("Room joining response:", joinResponse);

        user1.disconnect();
        user2.disconnect();
      });
    });
  });
});

user1.on("connect_error", (error) => {
  console.error("User 1 connection error:", error.message);
});

user2.on("connect_error", (error) => {
  console.error("User 2 connection error:", error.message);
});

user1.on("user-joined", (data) => {
  console.log("Another user joined the room:", data.socketId);
});
