const healthService = require("../service/health.service");

const checkHealth = (req, res) => {
  const result = healthService.getHealthStatus();

  return res.status(200).json(result);
};

module.exports = {
  checkHealth,
};