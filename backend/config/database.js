"use strict";

const { neon } = require("@neondatabase/serverless");
const { config } = require("./config");

// Create the Neon SQL tagged-template client using the DATABASE_URL
// from environment configuration.
const sql = neon(config.database.databaseUrl);

module.exports = { sql };
