import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  // Login name: lowercase, 3-20 characters, only a-z 0-9 _
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    minlength: 3,
    maxlength: 20,
    match: /^[a-z0-9_]+$/,
  },
  // bcrypt hash of the password (the real password is never saved)
  passwordHash: { type: String, required: true },
  // Public key of the user (a JWK object). The private key stays in the user's browser.
  publicKey: { type: Object, required: true },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
    keyBackup: { type: Object, default: null }, // passphrase se encrypted private key
});

const User = mongoose.model("User", userSchema);

export default User;