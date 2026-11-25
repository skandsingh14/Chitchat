import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  // Both are base64 text. The server cannot read the message (it is encrypted).
  iv: { type: String, required: true },
  ciphertext: { type: String, required: true },
  status: { type: String, enum: ["sent", "delivered", "read"], default: "sent" },
  createdAt: { type: Date, default: Date.now },

  // [CHANGED A] NEW FIELD: emoji reactions on this message.
  // Each person can have only one reaction per message.
  // The emoji is stored as plain text (the message text itself stays encrypted).
  reactions: {
    type: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        emoji: { type: String, required: true },
      },
    ],
    default: [],
  },
});

// Makes loading a conversation between two users fast
messageSchema.index({ from: 1, to: 1, createdAt: 1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;