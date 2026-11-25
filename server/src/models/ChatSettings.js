import mongoose from "mongoose";

// One record = "MY settings for MY chat with ONE other person".
// It is per-user, so it never changes what the other person sees.
// If no record exists, every value is simply the default.
const chatSettingsSchema = new mongoose.Schema({
  // The person who owns these settings
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  // The other person in the chat
  other: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  pinned: { type: Boolean, default: false },       // pinned chats show at the top
  archived: { type: Boolean, default: false },     // moved out of the main list
  mutedUntil: { type: Date, default: null },       // null = not muted
  markedUnread: { type: Boolean, default: false }, // "mark as unread" flag
  clearedAt: { type: Date, default: null },        // messages before this are hidden for me
  hidden: { type: Boolean, default: false },       // true = chat deleted from my list
});

// Only one settings record for each (owner, other) pair.
// This also makes looking them up fast.
chatSettingsSchema.index({ owner: 1, other: 1 }, { unique: true });

const ChatSettings = mongoose.model("ChatSettings", chatSettingsSchema);

export default ChatSettings;