import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import User from "../models/User.js";

const router = Router();

const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// Used so a login for an unknown user takes about as long as a real one
const DUMMY_HASH = bcrypt.hashSync("dummy-password", BCRYPT_ROUNDS);

// ---------- Rate limits (stop people from guessing passwords) ----------
const limiterOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
};

const loginLimiter = rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 10 });
const signupLimiter = rateLimit({ ...limiterOptions, windowMs: 60 * 60 * 1000, limit: 10 });

// Makes the login token: payload { id }, valid for 7 days
function signToken(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

// publicKey must be an object that looks like an EC P-256 public JWK
function isValidPublicKey(key) {
  return (
    key !== null &&
    typeof key === "object" &&
    !Array.isArray(key) &&
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string"
  );
}

// ---------- POST /api/auth/signup ----------
router.post("/signup", signupLimiter, async (req, res, next) => {
  try {
    const { username, password, publicKey } = req.body || {};

    if (typeof username !== "string") {
      return res.status(400).json({ error: "Username is required" });
    }
    const name = username.trim().toLowerCase();
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: "Username must be 3-20 characters: a-z, 0-9 or _" });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    // bcrypt only uses the first 72 bytes of a password
    if (Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({ error: "Password must be at most 72 characters" });
    }

    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: "publicKey must be an EC P-256 JWK object" });
    }

    if (await User.exists({ username: name })) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({
      username: name,
      passwordHash,
      // keep only the fields we need
      publicKey: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y },
    });

    res.status(201).json({
      token: signToken(user),
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    // Two people signing up with the same name at the same moment
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "Username already taken" });
    }
    next(err);
  }
});

// ---------- POST /api/auth/login ----------
router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    // Every kind of failure gives the same answer, so nobody can find out which usernames exist
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = await User.findOne({ username: username.trim().toLowerCase() });

    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({
      token: signToken(user),
      user: { id: user.id, username: user.username, publicKey: user.publicKey },
    });
  } catch (err) {
    next(err);
  }
});

export default router;