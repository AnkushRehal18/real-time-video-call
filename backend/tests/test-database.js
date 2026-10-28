
const { sql } = require("../config/database");

async function testConnection() {
  try {
    const result = await sql`
      SELECT NOW() AS current_time, version() AS version
    `;

    console.log("Neon database connected successfully!");
    console.log("Database time:", result[0].current_time);
    console.log(
      "PostgreSQL:",
      result[0].version.split(" ").slice(0, 2).join(" ")
    );
  } catch (error) {
    console.error("Database connection failed:", error.message);
    process.exitCode = 1;
  }
}

testConnection();
