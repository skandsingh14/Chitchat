import mongoose from "mongoose";

// Dono users ki ids ko sort karke jodte hain, taaki (A,B) aur (B,A) ki key same ho
export function pairKey(idA, idB) {
  return [String(idA), String(idB)].sort().join("_");
}

const chatTimerSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seconds: { type: Number, default: 0 }, // 0 = disappearing off
  setBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

export default mongoose.model("ChatTimer", chatTimerSchema);