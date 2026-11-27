// Friends list ke routes (sab login ke baad hi chalte hain)
import express from "express";
import mongoose from "mongoose";
import auth from "../middleware/auth.js";
import Friend from "../models/Friend.js";
import User from "../models/User.js";

const router = express.Router();

// Har route pe pehle login check (auth sets req.userId)
router.use(auth);

// ---------- GET /api/friends : meri friends list ----------
router.get("/", async (req, res) => {
  try {
    // Newest added pehle
    const rows = await Friend.find({ owner: req.userId })
      .sort({ createdAt: -1 })
      .populate({ path: "friend", select: "username lastSeen" }) // sirf safe fields
      .lean();

    // Agar koi user delete ho gaya ho to populate null dega, use skip karo
    const list = rows
      .filter((r) => r.friend)
      .map((r) => ({
        id: String(r.friend._id),
        username: r.friend.username,
        lastSeen: r.friend.lastSeen || null,
      }));

    res.json(list);
  } catch (err) {
    console.error("Get friends error:", err.message);
    res.status(500).json({ error: "Could not load friends" });
  }
});

// ---------- POST /api/friends/:userId : friend add karo ----------
router.post("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // 1. id sahi format me hai?
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // 2. khud ko add nahi kar sakte
    if (userId === req.userId) {
      return res.status(400).json({ error: "You cannot add yourself" });
    }

    // 3. user exist karta hai? (sirf username chahiye)
    const user = await User.findById(userId).select("username");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // 4. upsert: pehle se hai to kuch nahi hota, error bhi nahi aata
    await Friend.updateOne(
      { owner: req.userId, friend: userId },
      { $setOnInsert: { owner: req.userId, friend: userId, createdAt: new Date() } },
      { upsert: true }
    );

    res.json({ ok: true, friend: { id: String(user._id), username: user.username } });
  } catch (err) {
    console.error("Add friend error:", err.message);
    res.status(500).json({ error: "Could not add friend" });
  }
});

// ---------- DELETE /api/friends/:userId : friend hatao ----------
// Dhyan: sirf Friend ka record hatta hai. Messages / chat / ChatSettings ko haath nahi lagate.
router.delete("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    await Friend.deleteOne({ owner: req.userId, friend: userId });

    res.json({ ok: true });
  } catch (err) {
    console.error("Remove friend error:", err.message);
    res.status(500).json({ error: "Could not remove friend" });
  }
});

export default router;