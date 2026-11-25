import express from "express";
import mongoose from "mongoose";
import auth from "../middleware/auth.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import ChatSettings from "../models/ChatSettings.js"; // BATCH A

const router = express.Router();

// Is file ke saare routes ke liye login zaroori hai
router.use(auth);

/* ------------------------------------------------------------------
   GET /api/messages/conversations
   Kis kis se baat hui, unread count, pin/archive/mute ki info
   NOTE: ye /:userId se PEHLE hona chahiye, warna "conversations"
   ko userId samajh liya jaayega.
------------------------------------------------------------------- */
router.get("/conversations", async (req, res) => {
  try {
    const me = req.userId;

    // BATCH A: meri saari chat settings (pin, archive, clear, hidden...)
    const settingsList = await ChatSettings.find({ owner: me }).lean();
    const settingsMap = new Map(settingsList.map((s) => [String(s.other), s]));

    // Mere saare messages (sirf zaroori fields, naye se purane)
    const msgs = await Message.find({ $or: [{ from: me }, { to: me }] })
      .select("from to status createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // otherUserId -> { lastCreatedAt, unread }
    const convs = new Map();

    for (const m of msgs) {
      const fromMe = String(m.from) === me;
      const otherId = String(fromMe ? m.to : m.from);

      // BATCH A: clear kiye hue time se purane messages ignore karo
      const s = settingsMap.get(otherId);
      const clearedAt = s && s.clearedAt ? new Date(s.clearedAt) : null;
      if (clearedAt && m.createdAt <= clearedAt) continue;

      let c = convs.get(otherId);
      if (!c) {
        // Naye se purane order hai, isliye pehla message hi latest hai
        c = { lastCreatedAt: m.createdAt, unread: 0 };
        convs.set(otherId, c);
      }
      // Mujhe aaya hua aur abhi read nahi hua = unread
      if (!fromMe && m.status !== "read") c.unread++;
    }

    // BATCH A: chat clear ho chuki hai par hidden nahi, to bhi list mein dikhao
    for (const s of settingsList) {
      const otherId = String(s.other);
      if (s.clearedAt && !s.hidden && !convs.has(otherId)) {
        convs.set(otherId, { lastCreatedAt: s.clearedAt, unread: 0 });
      }
    }

    // BATCH A: hidden (delete ki hui) chats hata do
    for (const otherId of [...convs.keys()]) {
      const s = settingsMap.get(otherId);
      if (s && s.hidden) convs.delete(otherId);
    }

    // Dusre users ke username lao
    const ids = [...convs.keys()];
    const users = await User.find({ _id: { $in: ids } })
      .select("username")
      .lean();

    const result = users.map((u) => {
      const id = String(u._id);
      const c = convs.get(id);
      const s = settingsMap.get(id) || {};
      return {
        user: { id, username: u.username },
        lastMessage: { createdAt: c.lastCreatedAt },
        unread: c.unread,
        pinned: !!s.pinned,               // BATCH A
        archived: !!s.archived,           // BATCH A
        mutedUntil: s.mutedUntil || null, // BATCH A
        markedUnread: !!s.markedUnread,   // BATCH A
      };
    });

    // BATCH A: pehle pinned, phir sabse naya upar
    result.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt);
    });

    res.json(result);
  } catch (err) {
    console.error("conversations error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------------------------------------------
   GET /api/messages/:userId
   Mere aur is user ke beech ki poori history (purane se naye)
------------------------------------------------------------------- */
router.get("/:userId", async (req, res) => {
  try {
    const me = req.userId;
    const other = req.params.userId;

    if (!mongoose.isValidObjectId(other)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const query = {
      $or: [
        { from: me, to: other },
        { from: other, to: me },
      ],
    };

    // BATCH A: sirf clear ke baad wale messages
    const s = await ChatSettings.findOne({ owner: me, other }).lean();
    if (s && s.clearedAt) {
      query.createdAt = { $gt: s.clearedAt };
    }

    const msgs = await Message.find(query).sort({ createdAt: 1 }).lean();

    res.json(
      msgs.map((m) => ({
        id: String(m._id),
        from: String(m.from),
        to: String(m.to),
        iv: m.iv,
        ciphertext: m.ciphertext,
        status: m.status,
        createdAt: m.createdAt,
        // BATCH A: reactions bhi bhejo
        reactions: (m.reactions || []).map((r) => ({
          user: String(r.user),
          emoji: r.emoji,
        })),
      }))
    );
  } catch (err) {
    console.error("history error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;