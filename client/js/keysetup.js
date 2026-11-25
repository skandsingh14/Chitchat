// keysetup.js - login ke time key check aur restore
// Raasta 1: login PASSWORD hi backup ka passphrase hai (koi popup nahi).
// Dhyan: ye sirf learning project ke liye hai, asli secure app ke liye nahi.

import { apiGet } from "./api.js";
import { hasKeys, keysMatch, restoreKeys } from "./crypto.js";

// true = is browser mein sahi key hai (ya backup se restore ho gayi)
// false = key nahi mili (backup nahi hai, ya restore fail hua)
// Login ke baad (token save hone ke baad) call karo.
export async function ensureKeysOnLogin(username, serverPublicKey, password) {
  // Pehle se sahi key hai to kuch karna nahi
  if ((await hasKeys(username)) && (await keysMatch(username, serverPublicKey))) {
    return true;
  }

  // Server se encrypted backup lo
  let backup;
  try {
    backup = (await apiGet("/api/keys/backup")).keyBackup;
  } catch {
    return false; // is account ka backup hi nahi hai
  }

  // Login password se backup kholo
  try {
    await restoreKeys(username, backup, password);
    return await keysMatch(username, serverPublicKey);
  } catch {
    return false;
  }
}