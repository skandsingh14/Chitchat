// crypto.js - saari cryptography yahin hai (Web Crypto API)
// Private key browser ke IndexedDB mein NON-extractable rakhi jaati hai.
// Backup ke liye key passphrase se encrypt hoke server pe jaati hai (PBKDF2 + AES-GCM).

const DB_NAME = "chatapp-keys";
const STORE = "keys";
const CURVE = { name: "ECDH", namedCurve: "P-256" };
const PBKDF2_ITERATIONS = 310000;

// Shared AES keys ka cache (neeche getSharedKey use karta hai)
const derivedCache = new Map();

// ---------- base64 helpers (badi data pe bhi crash nahi karte) ----------
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function currentUsername() {
  return JSON.parse(sessionStorage.getItem("user")).username;
}

function cleanPublic(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

// Private JWK ko NON-extractable CryptoKey bana deta hai
async function importPrivateNonExtractable(privJwk) {
  const jwk = { ...privJwk };
  delete jwk.ext;
  delete jwk.key_ops;
  return crypto.subtle.importKey("jwk", jwk, CURVE, false, ["deriveKey"]);
}

// ---------- Passphrase se AES key ----------
async function keyFromPassphrase(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ---------- Key banana (SIGNUP ke liye) ----------
// Abhi kuch store nahi hota. Signup SUCCESS hone ke baad prepared.save() chalao.
// Isse signup fail hone par purani key overwrite nahi hoti.
export async function prepareKeys(username, passphrase) {
  // Backup ke liye abhi extractable banate hain, store karte time non-extractable ho jaayegi
  const pair = await crypto.subtle.generateKey(CURVE, true, ["deriveKey"]);
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = cleanPublic(await crypto.subtle.exportKey("jwk", pair.publicKey));

  // Private key ko passphrase se encrypt karo
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await keyFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
  const enc = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(privJwk))
  );
  const backup = {
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ciphertext: bufToB64(enc),
    iterations: PBKDF2_ITERATIONS,
  };

  return {
    publicJwk,
    backup, // ye server ko bhejna hai: POST /api/keys/backup
    save: async () => {
      const privateKey = await importPrivateNonExtractable(privJwk);
      await dbPut(username, { privateKey, publicJwk });
      derivedCache.clear();
    },
  };
}

// Purana naam (compatibility). Backup ke bina, isliye naye code mein prepareKeys use karo.
export async function generateAndStoreKeys(username) {
  const pair = await crypto.subtle.generateKey(CURVE, false, ["deriveKey"]);
  const publicJwk = cleanPublic(await crypto.subtle.exportKey("jwk", pair.publicKey));
  await dbPut(username, { privateKey: pair.privateKey, publicJwk });
  derivedCache.clear();
  return publicJwk;
}

// ---------- Key check ----------
export async function hasKeys(username) {
  try {
    return !!(await dbGet(username));
  } catch {
    return false;
  }
}

// Browser ki key server wali public key se match karti hai ya nahi
export async function keysMatch(username, serverPublicJwk) {
  const rec = await dbGet(username);
  if (!rec || !serverPublicJwk) return false;
  return rec.publicJwk.x === serverPublicJwk.x && rec.publicJwk.y === serverPublicJwk.y;
}

// ---------- Backup se key wapas laana (NAYE BROWSER mein) ----------
export async function restoreKeys(username, backup, passphrase) {
  let privJwk;
  try {
    const aes = await keyFromPassphrase(passphrase, b64ToBuf(backup.salt), backup.iterations);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBuf(backup.iv) }, aes, b64ToBuf(backup.ciphertext)
    );
    privJwk = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error("Wrong passphrase");
  }
  const privateKey = await importPrivateNonExtractable(privJwk);
  const publicJwk = { kty: "EC", crv: "P-256", x: privJwk.x, y: privJwk.y };
  await dbPut(username, { privateKey, publicJwk });
  derivedCache.clear();
}

// ---------- Shared AES key (ECDH) ----------
async function getSharedKey(theirPublicJwk) {
  const username = currentUsername();
  const rec = await dbGet(username);
  if (!rec) throw new Error("Encryption key is browser mein nahi hai");

  const cacheKey = username + "|" + theirPublicJwk.x + theirPublicJwk.y;
  if (derivedCache.has(cacheKey)) return derivedCache.get(cacheKey);

  const theirKey = await crypto.subtle.importKey("jwk", cleanPublic(theirPublicJwk), CURVE, true, []);
  const aes = await crypto.subtle.deriveKey(
    { name: "ECDH", public: theirKey },
    rec.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  derivedCache.set(cacheKey, aes);
  return aes;
}

// ---------- Message encrypt / decrypt ----------
export async function encryptMessage(plainText, theirPublicJwk) {
  const aes = await getSharedKey(theirPublicJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // HAR message ke liye naya IV
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(plainText));
  return { iv: bufToB64(iv), ciphertext: bufToB64(ct) };
}

export async function decryptMessage({ iv, ciphertext }, theirPublicJwk) {
  try {
    const aes = await getSharedKey(theirPublicJwk);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBuf(iv) }, aes, b64ToBuf(ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Decrypt failed");
  }
}