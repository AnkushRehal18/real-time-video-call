"use strict";

require("dotenv").config();

const config = {
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || "development",
  },
  logging: {
    // Overridden by LOG_LEVEL env var in logger.js; exposed here for reference
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  },
};

module.exports = { config };
