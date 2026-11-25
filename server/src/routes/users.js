// routes/users.js
// Routes for finding users and reading a user's public info.
// Every route here needs a valid login token (auth middleware).

import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import auth from "../middleware/auth.js";

const router = express.Router();

// Run the auth check for ALL routes in this file
router.use(auth);

// Turn special regex characters (like . * + ?) into plain text.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/users/search?q=abc
// Returns up to 10 users whose username contains the text, except yourself.
router.get("/search", async (req, res) => {
  try {
    let q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json([]);
    if (q.length > 50) q = q.slice(0, 50);

    const users = await User.find({
      username: { $regex: escapeRegex(q), $options: "i" },
      _id: { $ne: req.userId },
    })
      .select("username")
      .limit(10)
      .lean();

    res.json(users.map((u) => ({ id: String(u._id), username: u.username })));
  } catch (err) {
    console.error("User search error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/users/:id
// Returns public info of one user (including the public key).
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const user = await User.findById(id)
      .select("username publicKey lastSeen")
      .lean();

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      id: String(user._id),
      username: user.username,
      publicKey: user.publicKey,
      lastSeen: user.lastSeen,
    });
  } catch (err) {
    console.error("Get user error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;