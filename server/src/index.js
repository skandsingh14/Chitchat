import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import chatRoutes from "./routes/chats.js";
import keysRoutes from "./routes/keys.js";

import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import messageRoutes from "./routes/messages.js";
import { initSocket } from "./socket.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.resolve(__dirname, "../../client");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set");
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);

app.use(express.json());

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/keys", keysRoutes);

// JSON 404 for unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Static client
app.use(express.static(clientDir));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message,
  });
});

initSocket(httpServer);

const PORT = process.env.PORT || 3000;

await connectDB();
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});