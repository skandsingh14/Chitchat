import express from "express";
import auth from "../middleware/auth.js";
import User from "../models/User.js";

const router = express.Router();
router.use(auth);

const isStr = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

// Backup save karo (sirf encrypted blob, server isse padh nahi sakta)
router.post("/backup", async (req, res) => {
  try {
    const { salt, iv, ciphertext, iterations } = req.body || {};
    if (!isStr(salt, 100) || !isStr(iv, 100) || !isStr(ciphertext, 5000) ||
        !Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) {
      return res.status(400).json({ error: "Invalid backup" });
    }
    await User.updateOne({ _id: req.userId }, { $set: { keyBackup: { salt, iv, ciphertext, iterations } } });
    res.json({ ok: true });
  } catch (err) {
    console.error("backup save error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Backup wapas lo (naye browser mein login ke baad)
router.get("/backup", async (req, res) => {
  try {
    const u = await User.findById(req.userId).select("keyBackup").lean();
    if (!u || !u.keyBackup) return res.status(404).json({ error: "No backup found" });
    res.json({ keyBackup: u.keyBackup });
  } catch (err) {
    console.error("backup get error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;