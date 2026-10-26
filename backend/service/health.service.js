const getHealthStatus = () => {
  return {
    success: true,
    message: "Video Call API is healthy",
  };
};

module.exports = {
  getHealthStatus,
};