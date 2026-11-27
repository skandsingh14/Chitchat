// Friend model: "owner" ne "friend" ko apni list me add kiya hai.
// Ye one-sided hai: A ne B ko add kiya to B ki list me A apne aap nahi aayega.
import mongoose from "mongoose";

const friendSchema = new mongoose.Schema({
  // Jisne friend add kiya (list ka malik)
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  // Jise add kiya gaya
  friend: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  // Kab add kiya (newest first sort ke liye)
  createdAt: { type: Date, default: Date.now },
});

// Ek owner ek friend ko sirf ek hi baar add kar sakta hai
friendSchema.index({ owner: 1, friend: 1 }, { unique: true });

// Owner se list jaldi nikalne ke liye
friendSchema.index({ owner: 1 });

const Friend = mongoose.model("Friend", friendSchema);

export default Friend;