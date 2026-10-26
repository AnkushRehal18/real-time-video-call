require("dotenv").config();

const config = {
    server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV
  },
}

module.exports = {config}