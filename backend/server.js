const express = require("express")
const app = express()
const { config } = require("./config/config");
const heatlhRouter = require("./routes/health.route")
const http = require("http");
const initializeSocket = require("./utils/socket");

app.use(express.json());


//API Routes
app.use(heatlhRouter)

const server = http.createServer(app);
initializeSocket(server);



server.listen(config.server.port, () => {
    console.log(`Server running at PORT ${config.server.port}`);
})