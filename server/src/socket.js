// socket.js
// Real-time part of the chat: sending messages, typing, read receipts, online status.

import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "./models/User.js";
import Message from "./models/Message.js";
import ChatSettings from "./models/ChatSettings.js"; // BATCH A

// Size limits for incoming messages
const MAX_CIPHERTEXT = 20000;
const MAX_IV = 100;
const MAX_EMOJI = 8; // BATCH A: a reaction can be at most 8 characters

// Who is online? Map of userId -> number of open sockets (a user may have many tabs).
const onlineUsers = new Map();

// Small helper: is this a non-empty string within a size limit?
function isValidText(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function initSocket(httpServer) {
  // Same origin as the Express app, so no CORS settings are needed
  const io = new Server(httpServer);

  // ---------- Authentication: runs once for every new connection ----------
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Unauthorized"));

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = String(payload.id); // the server ALWAYS uses this as the sender
      next();
    } catch (err) {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.userId;

    // Each user gets a room named after their id, so we can message all their tabs
    socket.join(userId);

    // ---------- Track online status ----------
    const count = onlineUsers.get(userId) || 0;
    onlineUsers.set(userId, count + 1);

    // First socket for this user -> tell everyone they are online
    if (count === 0) {
      io.emit("presence", { userId, online: true });
    }

    // Tell ONLY this socket who is online right now
    socket.emit("online-users", Array.from(onlineUsers.keys()));

    // ---------- Offline delivery ----------
    // Messages sent to me while I was offline become "delivered" now.
    try {
      const pending = await Message.find({ to: userId, status: "sent" })
        .select("_id from")
        .lean();

      if (pending.length > 0) {
        await Message.updateMany(
          { _id: { $in: pending.map((m) => m._id) } },
          { $set: { status: "delivered" } }
        );

        // Tell each sender that their message was delivered
        for (const m of pending) {
          io.to(String(m.from)).emit("status-update", {
            id: String(m._id),
            status: "delivered",
          });
        }
      }
    } catch (err) {
      console.error("Offline delivery error:", err.message);
    }

    // ---------- Send a message ----------
    socket.on("send", async (data) => {
      try {
        if (!data || typeof data !== "object") return;
        const { to, iv, ciphertext, tempId } = data;

        // Validate the receiver id
        if (typeof to !== "string" || !mongoose.isValidObjectId(to)) return;
        if (to === userId) return; // cannot message yourself

        // Validate the encrypted data
        if (!isValidText(iv, MAX_IV)) return;
        if (!isValidText(ciphertext, MAX_CIPHERTEXT)) return;

        // Receiver must exist
        const receiverExists = await User.exists({ _id: to });
        if (!receiverExists) return;

        // Save the message. "from" is ALWAYS socket.userId (never trust the client)
        const message = await Message.create({
          from: userId,
          to,
          iv,
          ciphertext,
        });

        const id = String(message._id);

        // BATCH A: update chat settings. This has its own try/catch so that
        // a settings problem can never stop the message from being delivered.
        try {
          // RECEIVER's settings about the sender:
          // the chat comes back to their list (hidden=false) and leaves the archive,
          // unless they muted this chat (muted chats stay archived).
          const receiverSettings = await ChatSettings.findOne({
            owner: to,
            other: userId,
          })
            .select("mutedUntil")
            .lean();

          const isMuted =
            receiverSettings &&
            receiverSettings.mutedUntil &&
            new Date(receiverSettings.mutedUntil) > new Date();

          const receiverChanges = { hidden: false };
          if (!isMuted) receiverChanges.archived = false;

          await ChatSettings.updateOne(
            { owner: to, other: userId },
            { $set: receiverChanges },
            { upsert: true, setDefaultsOnInsert: true }
          );

          // SENDER's settings about the receiver:
          // if I had deleted this chat, it comes back because I wrote again.
          await ChatSettings.updateOne(
            { owner: userId, other: to },
            { $set: { hidden: false } },
            { upsert: true, setDefaultsOnInsert: true }
          );
        } catch (err) {
          console.error("send settings error:", err.message);
        }

        // 1) Confirm to the sender that the server saved it
        socket.emit("sent-ack", {
          tempId: typeof tempId === "string" ? tempId.slice(0, 100) : tempId,
          id,
          createdAt: message.createdAt,
        });

        // 2) Deliver to the receiver (all their tabs)
        io.to(to).emit("receive", {
          id,
          from: userId,
          to,
          iv,
          ciphertext,
          createdAt: message.createdAt,
        });

        // 3) If the receiver is online, mark as delivered and tell the sender
        if (onlineUsers.has(to)) {
          await Message.updateOne({ _id: message._id }, { $set: { status: "delivered" } });
          io.to(userId).emit("status-update", { id, status: "delivered" });
        }
      } catch (err) {
        console.error("send error:", err.message);
      }
    });

    // ---------- Mark messages as read ----------
    socket.on("mark-read", async (data) => {
      try {
        if (!data || typeof data.from !== "string") return;
        const from = data.from;
        if (!mongoose.isValidObjectId(from)) return;

        // BATCH A: opening the chat removes the "marked unread" flag for the reader.
        // This is done BEFORE the check below, so it works even when there are
        // no unread messages.
        await ChatSettings.updateOne(
          { owner: userId, other: from },
          { $set: { markedUnread: false } },
          { upsert: true, setDefaultsOnInsert: true }
        );

        // Find messages from that user to me that are not read yet
        const unread = await Message.find({
          from,
          to: userId,
          status: { $ne: "read" },
        })
          .select("_id")
          .lean();

        if (unread.length === 0) return;

        await Message.updateMany(
          { _id: { $in: unread.map((m) => m._id) } },
          { $set: { status: "read" } }
        );

        // Tell the original sender about each read message
        for (const m of unread) {
          io.to(from).emit("status-update", { id: String(m._id), status: "read" });
        }
      } catch (err) {
        console.error("mark-read error:", err.message);
      }
    });

    // ---------- BATCH A: React to a message with an emoji ----------
    // data = { messageId, emoji }   (emoji = "" means remove my reaction)
    socket.on("react", async (data) => {
      try {
        if (!data || typeof data !== "object") return;
        const { messageId, emoji } = data;

        // Validate the message id
        if (typeof messageId !== "string" || !mongoose.isValidObjectId(messageId)) return;

        // Validate the emoji: a string, at most 8 characters ("" is allowed = remove)
        if (typeof emoji !== "string" || emoji.length > MAX_EMOJI) return;

        const message = await Message.findById(messageId);
        if (!message) return;

        // Only the sender or the receiver of the message may react
        const senderId = String(message.from);
        const receiverId = String(message.to);
        if (userId !== senderId && userId !== receiverId) return;

        // One reaction per user: first remove my old reaction (if any)...
        message.reactions = message.reactions.filter((r) => String(r.user) !== userId);

        // ...then add the new one (unless the emoji is "" which means remove)
        if (emoji !== "") {
          message.reactions.push({ user: userId, emoji });
        }

        await message.save();

        // Send the updated reactions to BOTH people (all their tabs)
        const payload = {
          id: String(message._id),
          reactions: message.reactions.map((r) => ({
            user: String(r.user),
            emoji: r.emoji,
          })),
        };
        io.to(senderId).emit("reaction-update", payload);
        io.to(receiverId).emit("reaction-update", payload);
      } catch (err) {
        console.error("react error:", err.message);
      }
    });

        // ---------- DELETE MSG: Delete for me ----------
    // data = { messageId }
    socket.on("delete-for-me", async (data, cb) => {
      const reply = typeof cb === "function" ? cb : () => {};
      try {
        if (!data || typeof data.messageId !== "string" || !mongoose.isValidObjectId(data.messageId)) {
          return reply({ error: "Invalid message" });
        }
        const message = await Message.findById(data.messageId);
        if (!message) return reply({ error: "Message not found" });

        const senderId = String(message.from);
        const receiverId = String(message.to);
        if (userId !== senderId && userId !== receiverId) return reply({ error: "Not allowed" });

        const otherId = userId === senderId ? receiverId : senderId;
        const otherDeleted = message.deletedFor.some((u) => String(u) === otherId);

        if (otherDeleted) {
          // Dono ne delete kar diya -> database se poora hata do
          await Message.deleteOne({ _id: message._id });
        } else {
          await Message.updateOne({ _id: message._id }, { $addToSet: { deletedFor: userId } });
        }

        // Sirf meri screen (saare tabs) se hatao
        io.to(userId).emit("message-hidden", { id: String(message._id) });
        reply({ ok: true });
      } catch (err) {
        console.error("delete-for-me error:", err.message);
        reply({ error: "Server error" });
      }
    });

    // ---------- DELETE MSG: Delete for everyone ----------
    // Sirf bhejne wala, sirf apne message ke liye
    socket.on("delete-for-everyone", async (data, cb) => {
      const reply = typeof cb === "function" ? cb : () => {};
      try {
        if (!data || typeof data.messageId !== "string" || !mongoose.isValidObjectId(data.messageId)) {
          return reply({ error: "Invalid message" });
        }
        const message = await Message.findById(data.messageId);
        if (!message) return reply({ error: "Message not found" });

        const senderId = String(message.from);
        const receiverId = String(message.to);
        if (userId !== senderId) return reply({ error: "Only the sender can delete for everyone" });

        const wasUnread = message.status !== "read";
        await Message.deleteOne({ _id: message._id });

        const payload = { id: String(message._id), from: senderId, wasUnread };
        io.to(senderId).emit("message-deleted", payload);
        io.to(receiverId).emit("message-deleted", payload);
        reply({ ok: true });
      } catch (err) {
        console.error("delete-for-everyone error:", err.message);
        reply({ error: "Server error" });
      }
    });
    // ---------- Typing indicators ----------
    socket.on("typing", (data) => {
      try {
        if (!data || typeof data.to !== "string" || !mongoose.isValidObjectId(data.to)) return;
        io.to(data.to).emit("typing", { from: userId });
      } catch (err) {
        console.error("typing error:", err.message);
      }
    });

    socket.on("stop-typing", (data) => {
      try {
        if (!data || typeof data.to !== "string" || !mongoose.isValidObjectId(data.to)) return;
        io.to(data.to).emit("stop-typing", { from: userId });
      } catch (err) {
        console.error("stop-typing error:", err.message);
      }
    });

    // ---------- Disconnect ----------
    socket.on("disconnect", async () => {
      try {
        const remaining = (onlineUsers.get(userId) || 1) - 1;

        if (remaining > 0) {
          // User still has other tabs open
          onlineUsers.set(userId, remaining);
          return;
        }

        // Last socket closed -> user is offline
        onlineUsers.delete(userId);
        const lastSeen = new Date();
        await User.updateOne({ _id: userId }, { $set: { lastSeen } });
        io.emit("presence", { userId, online: false, lastSeen });
      } catch (err) {
        console.error("disconnect error:", err.message);
      }
    });
  });

  return io;
}