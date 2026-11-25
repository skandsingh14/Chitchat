// =====================================================
// auth.js - login AND signup logic (Part D)
// One file for both pages ("loginForm" or "signupForm").
// Backup passphrase = login password (koi popup nahi).
// =====================================================

import { apiPost } from "./api.js";
import { prepareKeys } from "./crypto.js";
import { ensureKeysOnLogin } from "./keysetup.js";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// ---------- Page elements ----------
const $ = (id) => document.getElementById(id);
const loginForm = $("loginForm");
const signupForm = $("signupForm");
const usernameInput = $("username");
const passwordInput = $("password");
const confirmInput = $("confirmPassword");   // only on the signup page
const submitBtn = $("submitBtn");
const errorBox = $("errorBox");

// Only on the login page
const keyWarning = $("keyWarning");
const continueBtn = $("continueBtn");

// ---------- Small helpers ----------
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = "";
  errorBox.hidden = true;
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
}

function saveSession(data) {
  sessionStorage.setItem("token", data.token); // SESSION FIX
  sessionStorage.setItem( // SESSION FIX
    "user",
    JSON.stringify({ id: data.user.id, username: data.user.username })
  );
}

function goToChat() {
  window.location.href = "chat.html";
}

// =====================================================
// SIGNUP
// =====================================================

async function handleSignup(event) {
  event.preventDefault();
  clearError();

  const username = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const confirm = confirmInput.value;

  if (!USERNAME_RE.test(username)) {
    showError("Username must be 3-20 characters: only a-z, 0-9 and _");
    return;
  }
  if (password.length < 8) {
    showError("Password must be at least 8 characters");
    return;
  }
  if (password !== confirm) {
    showError("Passwords do not match");
    return;
  }

  setLoading(true);
  let finished = false;

  try {
    // 1) Keys banao. Backup isi password se lock hoga.
    const prepared = await prepareKeys(username, password);

    // 2) Account banao (sirf PUBLIC key server ko jaati hai)
    const data = await apiPost("/api/auth/signup", {
      username,
      password,
      publicKey: prepared.publicJwk,
    });

    // 3) Session save (backup request ke liye token chahiye)
    saveSession(data);

    // 4) Signup success, ab key is browser mein save karo
    await prepared.save();

    // 5) Encrypted backup server pe rakho
    try {
      await apiPost("/api/keys/backup", prepared.backup);
    } catch (e) {
      console.warn("Key backup save nahi hua:", e.message);
    }

    finished = true;
    goToChat();
  } catch (err) {
    showError(err.message || "Something went wrong. Please try again.");
  } finally {
    if (!finished) setLoading(false);
  }
}

// =====================================================
// LOGIN
// =====================================================

async function handleLogin(event) {
  event.preventDefault();
  clearError();

  const username = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (!username || !password) {
    showError("Please enter your username and password");
    return;
  }

  setLoading(true);
  let finished = false;

  try {
    const data = await apiPost("/api/auth/login", { username, password });
    saveSession(data);

    // Key sahi hai? Nahi to login password se backup restore karo
    let keysOk = false;
    try {
      keysOk = await ensureKeysOnLogin(data.user.username, data.user.publicKey, password);
    } catch {
      keysOk = false;
    }

    finished = true;
    if (keysOk) {
      goToChat();
    } else {
      showKeyWarning();
    }
  } catch (err) {
    showError(err.message || "Login failed. Please try again.");
  } finally {
    if (!finished) setLoading(false);
  }
}

function showKeyWarning() {
  loginForm.hidden = true;
  keyWarning.hidden = false;
}

// =====================================================
// START
// =====================================================

function init() {
  if (loginForm) {
    loginForm.addEventListener("submit", handleLogin);
    continueBtn.addEventListener("click", goToChat);
  } else if (signupForm) {
    signupForm.addEventListener("submit", handleSignup);
  }
}

if (sessionStorage.getItem("token")) { // SESSION FIX
  window.location.replace("chat.html");
} else {
  init();
}