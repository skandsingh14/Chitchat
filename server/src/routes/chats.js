import express from "express";
import mongoose from "mongoose";
import auth from "../middleware/auth.js";
import ChatSettings from "../models/ChatSettings.js";

const router = express.Router();

// Every route in this file needs a logged-in user
router.use(auth);

// Check the :userId in the URL on every route (400 if it is not a valid id)
router.param("userId", (req, res, next, userId) => {
  if (!mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  next();
});

const MAX_PINNED = 3; // a user can pin at most 3 chats

// Turns "8h" / "1w" / "always" into a Date
function mutedValueToDate(muted) {
  if (muted === "8h") return new Date(Date.now() + 8 * 60 * 60 * 1000);
  if (muted === "1w") return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return new Date("2100-01-01T00:00:00.000Z"); // "always"
}

// PATCH /api/chats/:userId
// Body can have any of: pinned, archived, muted, markedUnread
router.patch("/:userId", async (req, res) => {
  try {
    const owner = req.userId;
    const other = req.params.userId;
    const body = req.body || {};
    const changes = {}; // the fields we will actually update

    // --- Validate every field that was sent ---
    if ("pinned" in body) {
      if (typeof body.pinned !== "boolean") {
        return res.status(400).json({ error: "pinned must be true or false" });
      }
      changes.pinned = body.pinned;
    }
    if ("archived" in body) {
      if (typeof body.archived !== "boolean") {
        return res.status(400).json({ error: "archived must be true or false" });
      }
      changes.archived = body.archived;
    }
    if ("markedUnread" in body) {
      if (typeof body.markedUnread !== "boolean") {
        return res.status(400).json({ error: "markedUnread must be true or false" });
      }
      changes.markedUnread = body.markedUnread;
    }
    if ("muted" in body) {
      if (body.muted === null) {
        changes.mutedUntil = null; // unmute
      } else if (["8h", "1w", "always"].includes(body.muted)) {
        changes.mutedUntil = mutedValueToDate(body.muted);
      } else {
        return res.status(400).json({ error: 'muted must be "8h", "1w", "always" or null' });
      }
    }

    // --- Max 3 pinned chats ---
    if (changes.pinned === true) {
      // How many OTHER chats does this user already have pinned?
      const pinnedCount = await ChatSettings.countDocuments({
        owner,
        pinned: true,
        other: { $ne: other }, // don't count this chat itself
      });
      if (pinnedCount >= MAX_PINNED) {
        return res
          .status(400)
          .json({ error: `You can pin up to ${MAX_PINNED} chats only` });
      }
    }

    // --- Upsert: update the record, or create it if it does not exist ---
    const settings = await ChatSettings.findOneAndUpdate(
      { owner, other },
      { $set: changes, $setOnInsert: { owner, other } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({
      pinned: settings.pinned,
      archived: settings.archived,
      mutedUntil: settings.mutedUntil,
      markedUnread: settings.markedUnread,
    });
  } catch (err) {
    console.error("PATCH /api/chats error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/chats/:userId/clear
// "Clear chat": hides all old messages for me only.
router.post("/:userId/clear", async (req, res) => {
  try {
    await ChatSettings.findOneAndUpdate(
      { owner: req.userId, other: req.params.userId },
      {
        $set: { clearedAt: new Date(), markedUnread: false },
        $setOnInsert: { owner: req.userId, other: req.params.userId },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/chats/clear error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/chats/:userId
// "Delete chat": clears old messages and removes the chat from my list.
// (It comes back if the other person sends a new message.)
router.delete("/:userId", async (req, res) => {
  try {
    await ChatSettings.findOneAndUpdate(
      { owner: req.userId, other: req.params.userId },
      {
        $set: { clearedAt: new Date(), hidden: true, pinned: false, archived: false },
        $setOnInsert: { owner: req.userId, other: req.params.userId },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/chats error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;