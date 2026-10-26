const express = require("express");
const router = express.Router();

const healthController = require("../controller/health.controller");

router.get("/health", healthController.checkHealth);

module.exports = router;