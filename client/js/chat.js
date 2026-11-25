// =====================================================
// chat.js - all the logic for the chat screen (Part E)
// =====================================================
// What this file does:
//   1. Loads the chat list and lets you search for users
//   2. Opens a chat, decrypts old messages in the browser
//   3. Encrypts and sends new messages
//   4. Listens to live events (new message, ticks, typing, online status)
//   5. [BATCH A] Chat-list menu: pin, archive, mute, mark unread, clear, delete
//   6. [BATCH A] Reactions under message bubbles
//   7. [BATCH A] Search inside the open chat (in the browser only)

import { apiGet, apiPost, apiPatch, apiDelete } from "./api.js"; // BATCH A: apiPatch, apiDelete added
import { encryptMessage, decryptMessage } from "./crypto.js";
import { connectSocket, disconnectSocket } from "./socket.js";

// ---------- Small settings ----------
const DECRYPT_ERROR_TEXT = "Message decrypt nahi ho paya";
const SEARCH_DEBOUNCE_MS = 300;   // wait this long after typing before searching
const TYPING_THROTTLE_MS = 1000;  // send "typing" at most once per second
const TYPING_STOP_MS = 1500;      // no typing for 1.5s => send "stop-typing"
const TYPING_EXPIRE_MS = 5000;    // safety: hide "typing..." if we never get "stop-typing"

// BATCH A: the 6 quick emojis shown when you click the 😀 button
const QUICK_EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F64F}"];

// Used so a status never goes backwards (read -> sent is not allowed)
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

// ---------- Page elements ----------
const $ = (id) => document.getElementById(id);
const app = $("app");
const sidebar = $("sidebar");
const myAvatar = $("myAvatar");
const myName = $("myName");
const logoutBtn = $("logoutBtn");
const searchInput = $("searchInput");
const searchResults = $("searchResults");
const conversationList = $("conversationList");
const placeholder = $("placeholder");
const chatWindow = $("chatWindow");
const backBtn = $("backBtn");
const headerAvatar = $("headerAvatar");
const chatTitle = $("chatTitle");
const chatStatus = $("chatStatus");
const messagesEl = $("messages");
const messageInput = $("messageInput");
const sendBtn = $("sendBtn");
const toast = $("toast");

// BATCH A: search-in-chat elements
const chatSearchBtn = $("chatSearchBtn");
const chatSearchBar = $("chatSearchBar");
const chatSearchInput = $("chatSearchInput");
const chatSearchCount = $("chatSearchCount");
const chatSearchPrev = $("chatSearchPrev");
const chatSearchNext = $("chatSearchNext");
const chatSearchClose = $("chatSearchClose");

// ---------- App data (our "memory" while the page is open) ----------
let me = { id: "", username: "" };      // the logged-in user
let socket = null;

// userId -> { user:{id,username}, lastAt, unread, pinned, archived, mutedUntil, markedUnread }
const conversations = new Map();
let onlineUsers = new Set();            // ids of users who are online right now
const lastSeenMap = new Map();          // userId -> last seen time (ISO string)
const typingUsers = new Set();          // ids of users who are typing to us right now
const typingTimers = new Map();         // userId -> timer that hides "typing..."
const userInfoCache = new Map();        // userId -> Promise of {id, username, publicKey, lastSeen}

let currentChat = null;                 // { id, username } of the open chat, or null
let openCounter = 0;                    // bumps on every open/close, to ignore old async results
let chatReady = false;                  // true when history of the open chat is on screen
let pendingIncoming = [];               // messages that arrived while history was loading

// messageId -> { id, mine, row, wrap, textEl, timeEl, tickEl, status, reactions, reactionsEl }
const messageEls = new Map();
const earlyStatus = new Map();          // status-update that arrived before we knew the message
let lastDateKey = "";                   // used to know when to add a new date separator

// typing (what WE send to others)
let typingTarget = null;
let lastTypingEmit = 0;
let stopTypingTimer = null;

// search
let searchTimer = null;
let searchSeq = 0;

// BATCH A: chat-list menu state
let showArchived = false;               // is the "Archived" section open?
let openMenu = null;                    // { el, id } of the dropdown that is open, or null

// BATCH A: reaction picker state
let openPicker = null;                  // { el, wrap } of the emoji row that is open, or null

// BATCH A: search-in-chat state
let chatSearchOpen = false;             // is the search bar open?
let chatMatches = [];                   // all <mark> elements found, oldest first
let chatMatchIndex = -1;                // which match is the "current" one
let chatSearchRefreshTimer = null;      // used when new messages arrive during a search

// ---------- Tiny helpers ----------

// Creates an element safely. Text is added with textContent (never innerHTML).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

// BATCH A: a message that is still waiting for the server has a temporary id
function isTempId(id) {
  return typeof id === "string" && id.startsWith("temp-");
}

// ---------- Date and time helpers ----------
function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function isYesterday(date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return sameDay(date, y);
}

// "10:35 AM"
function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Date separator inside a chat: "Today", "Yesterday" or "12 March 2026"
function dateLabel(iso) {
  const d = new Date(iso);
  if (sameDay(d, new Date())) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

// Time shown in the chat list
function formatListTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (sameDay(d, new Date())) return formatTime(iso);
  if (isYesterday(d)) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

// "last seen today at 10:35 AM"
function formatLastSeen(iso) {
  const d = new Date(iso);
  const time = formatTime(iso);
  if (sameDay(d, new Date())) return "last seen today at " + time;
  if (isYesterday(d)) return "last seen yesterday at " + time;
  const day = d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return "last seen " + day + " at " + time;
}

function timeValue(iso) {
  return iso ? new Date(iso).getTime() : 0;
}

// ---------- Avatar (round circle with first letter) ----------
function makeAvatar(username, online) {
  const wrap = el("div", "avatar-wrap");
  wrap.appendChild(el("div", "avatar", (username || "?").charAt(0).toUpperCase()));
  if (online) wrap.appendChild(el("span", "online-dot"));
  return wrap;
}

// ---------- Getting info about another user ----------
// We cache the result so we only ask the server once per user (it includes their public key).
function getUserInfo(userId) {
  if (!userInfoCache.has(userId)) {
    const promise = apiGet("/api/users/" + userId).then((user) => {
      if (user.lastSeen && !lastSeenMap.has(userId)) lastSeenMap.set(userId, user.lastSeen);
      return user;
    });
    // If it fails, forget it so we can try again next time
    promise.catch(() => userInfoCache.delete(userId));
    userInfoCache.set(userId, promise);
  }
  return userInfoCache.get(userId);
}

// Decrypts one message. Returns the text, or null if it fails.
async function safeDecrypt(msg, theirPublicJwk) {
  try {
    return await decryptMessage({ iv: msg.iv, ciphertext: msg.ciphertext }, theirPublicJwk);
  } catch {
    return null;
  }
}

// =====================================================
// SIDEBAR: conversation list
// =====================================================

// BATCH A: is this chat muted right now? (mutedUntil is a date in the future)
function isMuted(conv) {
  return !!conv.mutedUntil && new Date(conv.mutedUntil) > new Date();
}

// BATCH A: pinned chats first, then the newest chat first
function sortConversations(list) {
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return timeValue(b.lastAt) - timeValue(a.lastAt);
  });
}

// BATCH A: the "Archived (N)" row at the top of the list
function buildArchivedRow(count) {
  const item = el("li", "user-item archived-row");
  item.tabIndex = 0;
  item.appendChild(el("span", "archived-text", "Archived (" + count + ")"));
  item.appendChild(el("span", "archived-arrow", showArchived ? "\u25BE" : "\u25B8"));

  const toggle = () => {
    showArchived = !showArchived;
    renderConversations();
  };
  item.addEventListener("click", toggle);
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter") toggle();
  });
  return item;
}

// Builds ONE row of the chat list
function buildConversationRow(conv) {
  const id = conv.user.id;
  const muted = isMuted(conv);
  const isActive = currentChat && currentChat.id === id;
  const item = el("li", "user-item" + (isActive ? " active" : "") + (conv.archived ? " archived-item" : ""));
  item.tabIndex = 0;

  item.appendChild(makeAvatar(conv.user.username, onlineUsers.has(id)));

  const body = el("div", "user-body");

  // Top row: name (+ pin / mute icons) and time
  const top = el("div", "user-row");
  const nameGroup = el("div", "name-group");
  nameGroup.appendChild(el("span", "user-name", conv.user.username));
  if (conv.pinned) nameGroup.appendChild(el("span", "conv-icon", "\u{1F4CC}")); // BATCH A: pin
  if (muted) nameGroup.appendChild(el("span", "conv-icon", "\u{1F515}"));       // BATCH A: muted
  top.appendChild(nameGroup);
  top.appendChild(el("span", "conv-time" + (conv.unread > 0 ? " unread" : ""), formatListTime(conv.lastAt)));
  body.appendChild(top);

  // Bottom row: small text + unread badge
  const bottom = el("div", "user-row");
  if (typingUsers.has(id)) {
    bottom.appendChild(el("span", "conv-preview typing", "typing..."));
  } else {
    bottom.appendChild(el("span", "conv-preview", "\u{1F512} Encrypted message"));
  }
  if (conv.unread > 0) {
    // BATCH A: grey badge when the chat is muted
    bottom.appendChild(
      el("span", "badge" + (muted ? " muted" : ""), conv.unread > 99 ? "99+" : String(conv.unread))
    );
  } else if (conv.markedUnread) {
    // BATCH A: "marked as unread" shows a small dot
    bottom.appendChild(el("span", "unread-dot"));
  }
  body.appendChild(bottom);

  item.appendChild(body);

  // BATCH A: the "⋮" button that opens the menu
  const menuBtn = el("button", "menu-btn", "\u22EE");
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", "Chat options");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // do not open the chat
    toggleMenu(id, menuBtn);
  });
  item.appendChild(menuBtn);

  item.addEventListener("click", () => openChat(conv.user));
  item.addEventListener("keydown", (e) => {
    // only when the row itself is focused (not the ⋮ button)
    if (e.key === "Enter" && e.target === item) openChat(conv.user);
  });
  return item;
}

function renderConversations() {
  // BATCH A: split into normal chats and archived chats
  const all = Array.from(conversations.values());
  const mainList = sortConversations(all.filter((c) => !c.archived));
  const archivedList = sortConversations(all.filter((c) => c.archived));

  // Nothing archived anymore -> close the archived section
  if (archivedList.length === 0) showArchived = false;

  conversationList.replaceChildren();

  if (mainList.length === 0 && archivedList.length === 0) {
    conversationList.appendChild(el("li", "empty-note", "No chats yet. Search for a user to start."));
    return;
  }

  // BATCH A: "Archived (N)" row at the very top
  if (archivedList.length > 0) {
    conversationList.appendChild(buildArchivedRow(archivedList.length));
    if (showArchived) {
      for (const conv of archivedList) conversationList.appendChild(buildConversationRow(conv));
    }
  }

  // Archived chats are NOT in the main list
  for (const conv of mainList) conversationList.appendChild(buildConversationRow(conv));
}

// Updates (or creates) a conversation entry and re-draws the list
function touchConversation(user, lastAt, addUnread) {
  let conv = conversations.get(user.id);
  if (!conv) {
    conv = {
      user: { id: user.id, username: user.username },
      lastAt: null,
      unread: 0,
      pinned: false,        // BATCH A
      archived: false,      // BATCH A
      mutedUntil: null,     // BATCH A
      markedUnread: false,  // BATCH A
    };
    conversations.set(user.id, conv);
  }
  if (lastAt) conv.lastAt = lastAt;
  conv.unread += addUnread;
  renderConversations();
}

async function loadConversations() {
  try {
    const list = await apiGet("/api/messages/conversations");
    for (const c of list) {
      conversations.set(c.user.id, {
        user: { id: c.user.id, username: c.user.username },
        lastAt: c.lastMessage ? c.lastMessage.createdAt : null,
        unread: c.unread || 0,
        pinned: !!c.pinned,               // BATCH A
        archived: !!c.archived,           // BATCH A
        mutedUntil: c.mutedUntil || null, // BATCH A
        markedUnread: !!c.markedUnread,   // BATCH A
      });
    }
  } catch (err) {
    showToast("Could not load chats: " + err.message);
  }
  renderConversations();
}

// =====================================================
// BATCH A: chat-list menu (⋮) and its actions
// =====================================================

function closeMenu() {
  if (openMenu) {
    openMenu.el.remove();
    openMenu = null;
  }
}

// One clickable line inside the dropdown
function menuItem(label, onClick, danger) {
  const btn = el("button", "menu-item" + (danger ? " danger" : ""), label);
  btn.type = "button";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// Opens the dropdown for one chat (or closes it if it is already open)
function toggleMenu(id, anchorBtn) {
  const wasOpenForThis = openMenu && openMenu.id === id;
  closeMenu();
  if (wasOpenForThis) return;

  const conv = conversations.get(id);
  if (!conv) return;

  const menu = el("div", "chat-menu");

  menu.appendChild(menuItem(conv.pinned ? "Unpin" : "Pin", () => patchChat(id, { pinned: !conv.pinned })));
  menu.appendChild(
    menuItem(conv.archived ? "Unarchive" : "Archive", () => patchChat(id, { archived: !conv.archived }))
  );

  if (isMuted(conv)) {
    menu.appendChild(menuItem("Unmute", () => patchChat(id, { muted: null })));
  } else {
    menu.appendChild(el("div", "menu-label", "Mute"));
    menu.appendChild(menuItem("Mute for 8 hours", () => patchChat(id, { muted: "8h" })));
    menu.appendChild(menuItem("Mute for 1 week", () => patchChat(id, { muted: "1w" })));
    menu.appendChild(menuItem("Mute always", () => patchChat(id, { muted: "always" })));
  }

  menu.appendChild(
    menuItem(conv.markedUnread ? "Mark as read" : "Mark as unread", () =>
      patchChat(id, { markedUnread: !conv.markedUnread })
    )
  );
  menu.appendChild(menuItem("Clear chat", () => clearChat(id), true));
  menu.appendChild(menuItem("Delete chat", () => deleteChat(id), true));

  // The menu lives on <body> (not inside the list) so the scrolling list cannot cut it off.
  document.body.appendChild(menu);

  // Place it under the button, and keep it inside the screen
  const rect = anchorBtn.getBoundingClientRect();
  let left = rect.right - menu.offsetWidth;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menu.offsetHeight - 4);
  }
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  openMenu = { el: menu, id };
}

// pin / archive / mute / mark unread: send the change, then use the server's answer
async function patchChat(id, changes) {
  closeMenu();
  try {
    const res = await apiPatch("/api/chats/" + id, changes);
    const conv = conversations.get(id);
    if (conv) {
      conv.pinned = !!res.pinned;
      conv.archived = !!res.archived;
      conv.mutedUntil = res.mutedUntil || null;
      conv.markedUnread = !!res.markedUnread;
    }
    renderConversations();
  } catch (err) {
    alert(err.message); // for example: "You can pin up to 3 chats only"
  }
}

// Clear chat: removes the old messages (only for me)
async function clearChat(id) {
  closeMenu();
  if (!window.confirm("Clear all messages in this chat?")) return;
  try {
    await apiPost("/api/chats/" + id + "/clear", {});
    const conv = conversations.get(id);
    if (conv) {
      conv.unread = 0;
      conv.markedUnread = false;
      conv.lastAt = new Date().toISOString();
    }
    // If this chat is open, empty the messages on screen
    if (currentChat && currentChat.id === id) {
      closeChatSearch(); // BATCH A: nothing left to search in
      resetMessages();
    }
    renderConversations();
  } catch (err) {
    alert(err.message);
  }
}

// Delete chat: removes the chat from my list
async function deleteChat(id) {
  closeMenu();
  if (!window.confirm("Delete this chat?")) return;
  try {
    await apiDelete("/api/chats/" + id);
    conversations.delete(id);
    if (currentChat && currentChat.id === id) {
      closeChat(); // closes the open chat (and re-draws the list)
    } else {
      renderConversations();
    }
  } catch (err) {
    alert(err.message);
  }
}

// =====================================================
// SIDEBAR: search
// =====================================================

function clearSearch() {
  searchSeq++;                       // makes any slow, old search result get ignored
  clearTimeout(searchTimer);
  searchResults.replaceChildren();
  searchResults.classList.add("hidden");
  sidebar.classList.remove("searching");
}

function renderSearchResults(users) {
  searchResults.replaceChildren();
  searchResults.classList.remove("hidden");
  sidebar.classList.add("searching");

  if (users.length === 0) {
    searchResults.appendChild(el("li", "empty-note", "No users found"));
    return;
  }

  for (const user of users) {
    const item = el("li", "user-item");
    item.tabIndex = 0;
    item.appendChild(makeAvatar(user.username, onlineUsers.has(user.id)));
    const body = el("div", "user-body");
    const row = el("div", "user-row");
    row.appendChild(el("span", "user-name", user.username));
    body.appendChild(row);
    item.appendChild(body);
    item.addEventListener("click", () => {
      searchInput.value = "";
      openChat(user);
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        searchInput.value = "";
        openChat(user);
      }
    });
    searchResults.appendChild(item);
  }
}

async function runSearch(query) {
  const mySeq = ++searchSeq;
  try {
    const users = await apiGet("/api/users/search?q=" + encodeURIComponent(query));
    if (mySeq !== searchSeq) return;   // a newer search started, ignore this one
    renderSearchResults(users);
  } catch (err) {
    if (mySeq !== searchSeq) return;
    searchResults.replaceChildren(el("li", "empty-note", "Search failed: " + err.message));
    searchResults.classList.remove("hidden");
    sidebar.classList.add("searching");
  }
}

function onSearchInput() {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (!query) {
    clearSearch();
    return;
  }
  // "Debounce": only search after the user stops typing for a moment
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

// =====================================================
// CHAT HEADER (name + online / last seen / typing)
// =====================================================

function statusText(userId) {
  if (typingUsers.has(userId)) return "typing...";
  if (onlineUsers.has(userId)) return "online";
  const seen = lastSeenMap.get(userId);
  return seen ? formatLastSeen(seen) : "";
}

function updateHeader() {
  if (!currentChat) return;
  const id = currentChat.id;
  chatTitle.textContent = currentChat.username;
  chatStatus.textContent = statusText(id);
  chatStatus.className =
    "chat-status" + (typingUsers.has(id) ? " typing" : onlineUsers.has(id) ? " online" : "");
  headerAvatar.replaceChildren(makeAvatar(currentChat.username, onlineUsers.has(id)));
}

// =====================================================
// MESSAGES on screen
// =====================================================

function resetMessages() {
  closePicker(); // BATCH A: the emoji row belongs to a message that is going away
  messagesEl.replaceChildren();
  messageEls.clear();
  earlyStatus.clear();
  lastDateKey = "";
  // BATCH A: all search highlights were on those messages, so forget them
  chatMatches = [];
  chatMatchIndex = -1;
  updateSearchCount();
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 150;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Draws the tick(s) of one of my messages
//   sent = one tick, delivered = two ticks, read = two blue ticks
function paintTick(rec) {
  if (!rec.tickEl) return;
  rec.tickEl.textContent = rec.status === "sent" ? "\u2713" : "\u2713\u2713";
  rec.tickEl.classList.toggle("read", rec.status === "read");
}

// =====================================================
// BATCH A: reactions
// =====================================================

// Which emoji did I use on this message? ("" if none)
function myReactionOf(rec) {
  const mine = rec.reactions.find((r) => String(r.user) === me.id);
  return mine ? mine.emoji : "";
}

// Draws the little chips under a bubble, e.g. "👍 2" and "❤️ 1"
function renderReactions(rec) {
  rec.reactionsEl.replaceChildren();

  // Group by emoji and count (a Map keeps the order of first use)
  const groups = new Map(); // emoji -> { count, mine }
  for (const r of rec.reactions) {
    if (!r.emoji) continue;
    const g = groups.get(r.emoji) || { count: 0, mine: false };
    g.count++;
    if (String(r.user) === me.id) g.mine = true;
    groups.set(r.emoji, g);
  }

  rec.reactionsEl.classList.toggle("hidden", groups.size === 0);

  for (const [emoji, g] of groups) {
    const chip = el("span", "reaction-chip" + (g.mine ? " mine" : ""));
    chip.appendChild(el("span", "reaction-emoji", emoji));
    chip.appendChild(el("span", "reaction-count", String(g.count)));
    rec.reactionsEl.appendChild(chip);
  }
}

function closePicker() {
  if (openPicker) {
    openPicker.el.remove();
    openPicker.wrap.classList.remove("show-actions");
    openPicker = null;
  }
}

// Sends my reaction to the server. The screen updates when "reaction-update" comes back.
function sendReaction(rec, emoji) {
  if (isTempId(rec.id)) {
    showToast("Please wait, the message is still sending.");
    return;
  }
  // Clicking the emoji I already used removes my reaction
  const newEmoji = myReactionOf(rec) === emoji ? "" : emoji;
  socket.emit("react", { messageId: rec.id, emoji: newEmoji });
}

// Opens the row of 6 quick emojis above a bubble (or closes it if already open)
function togglePicker(rec) {
  const wasOpenForThis = openPicker && openPicker.wrap === rec.wrap;
  closePicker();
  if (wasOpenForThis) return;

  if (isTempId(rec.id)) {
    showToast("Please wait, the message is still sending.");
    return;
  }

  const picker = el("div", "react-picker");
  const mineNow = myReactionOf(rec);
  for (const emoji of QUICK_EMOJIS) {
    const btn = el("button", "react-option" + (emoji === mineNow ? " chosen" : ""), emoji);
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePicker();
      sendReaction(rec, emoji);
    });
    picker.appendChild(btn);
  }
  rec.wrap.appendChild(picker);
  rec.wrap.classList.add("show-actions"); // keeps the 😀 button visible while the row is open
  openPicker = { el: picker, wrap: rec.wrap };
}

// The server says the reactions of a message changed
function handleReactionUpdate({ id, reactions }) {
  const rec = messageEls.get(id);
  if (!rec) return; // that message is not on screen
  const wasNearBottom = isNearBottom();
  rec.reactions = Array.isArray(reactions) ? reactions : [];
  renderReactions(rec);
  if (wasNearBottom) scrollToBottom();

  // If the emoji row is open for this message, refresh the "chosen" highlight by closing it
  if (openPicker && openPicker.wrap === rec.wrap) closePicker();
}

// Adds one message bubble to the screen
function addMessage({ id, mine, text, createdAt, status, failed, reactions }) {
  // Add a date separator if this message is on a new day
  const key = new Date(createdAt).toDateString();
  if (key !== lastDateKey) {
    const sep = el("div", "date-sep");
    sep.appendChild(el("span", "", dateLabel(createdAt)));
    messagesEl.appendChild(sep);
    lastDateKey = key;
  }

  const row = el("div", "msg-row " + (mine ? "mine" : "theirs"));

  // BATCH A: the wrapper holds the bubble, the 😀 button and the reactions
  const wrap = el("div", "msg-wrap");
  const bubble = el("div", "bubble" + (failed ? " failed" : ""));
  const textEl = el("div", "msg-text", text);
  bubble.appendChild(textEl);

  const meta = el("div", "msg-meta");
  const timeEl = el("span", "msg-time", formatTime(createdAt));
  meta.appendChild(timeEl);

  let tickEl = null;
  if (mine) {
    tickEl = el("span", "tick");
    meta.appendChild(tickEl);
  }
  bubble.appendChild(meta);
  wrap.appendChild(bubble);

  // BATCH A: reactions shown under the bubble
  const reactionsEl = el("div", "reactions hidden");
  wrap.appendChild(reactionsEl);

  row.appendChild(wrap);
  messagesEl.appendChild(row);

  const rec = {
    id,
    mine,
    row,
    wrap,
    textEl,
    timeEl,
    tickEl,
    status: status || "sent",
    reactions: Array.isArray(reactions) ? reactions : [],
    reactionsEl,
  };
  if (mine) paintTick(rec);
  renderReactions(rec);
  messageEls.set(id, rec);

  // BATCH A: the small 😀 button (shows on hover, or after a tap on phones)
  const reactBtn = el("button", "react-btn", "\u{1F600}");
  reactBtn.type = "button";
  reactBtn.setAttribute("aria-label", "React to message");
  reactBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePicker(rec);
  });
  wrap.appendChild(reactBtn);

  // BATCH A: on touch screens (no hover) a tap on the bubble shows the 😀 button
  bubble.addEventListener("click", () => {
    if (!window.matchMedia("(hover: none)").matches) return;
    const wasShown = wrap.classList.contains("show-actions");
    closePicker();
    for (const w of messagesEl.querySelectorAll(".msg-wrap.show-actions")) {
      w.classList.remove("show-actions");
    }
    if (!wasShown) wrap.classList.add("show-actions");
  });

  // BATCH A: a new message appeared while the search bar is open -> refresh matches
  if (chatSearchOpen && chatSearchInput.value.trim()) scheduleSearchRefresh();

  return rec;
}

// Changes the ticks of a message (only moves forward: sent -> delivered -> read)
function applyStatus(id, status) {
  const rec = messageEls.get(id);
  if (!rec) {
    // We may not know this message yet (ack not processed). Remember the best status.
    const old = earlyStatus.get(id);
    if (!old || STATUS_RANK[status] > STATUS_RANK[old]) earlyStatus.set(id, status);
    return;
  }
  if (!rec.mine) return;
  if ((STATUS_RANK[status] || 0) > (STATUS_RANK[rec.status] || 0)) {
    rec.status = status;
    paintTick(rec);
  }
}

// =====================================================
// BATCH A: search inside the open chat
// =====================================================
// Everything here runs in the browser over messages that are already decrypted.
// Matches are wrapped in <mark> elements built with DOM nodes (no innerHTML).

// Shows "2 of 7", "No results" or nothing
function updateSearchCount() {
  const hasQuery = chatSearchInput.value.trim() !== "";
  if (!hasQuery) {
    chatSearchCount.textContent = "";
  } else if (chatMatches.length === 0) {
    chatSearchCount.textContent = "No results";
  } else {
    chatSearchCount.textContent = chatMatchIndex + 1 + " of " + chatMatches.length;
  }
  chatSearchPrev.disabled = chatMatches.length === 0;
  chatSearchNext.disabled = chatMatches.length === 0;
}

// Removes every <mark> and puts the plain text back
function clearHighlights() {
  const parents = new Set();
  for (const mark of messagesEl.querySelectorAll(".msg-text mark")) parents.add(mark.parentNode);
  for (const p of parents) p.textContent = p.textContent; // plain text again, no marks
  chatMatches = [];
  chatMatchIndex = -1;
}

// Wraps every match inside ONE message text. Returns the new <mark> elements.
function highlightInElement(textEl, lowerQuery) {
  const text = textEl.textContent;
  const lowerText = text.toLowerCase();
  let pos = lowerText.indexOf(lowerQuery);
  if (pos === -1) return [];

  const frag = document.createDocumentFragment();
  const marks = [];
  let last = 0;
  while (pos !== -1) {
    if (pos > last) frag.appendChild(document.createTextNode(text.slice(last, pos)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(pos, pos + lowerQuery.length);
    frag.appendChild(mark);
    marks.push(mark);
    last = pos + lowerQuery.length;
    pos = lowerText.indexOf(lowerQuery, last);
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textEl.replaceChildren(frag);
  return marks;
}

// Makes one match the "current" one (orange) and scrolls to it
function setActiveMatch(index, scroll) {
  if (chatMatches[chatMatchIndex]) chatMatches[chatMatchIndex].classList.remove("active");
  chatMatchIndex = index;
  const mark = chatMatches[index];
  if (mark) {
    mark.classList.add("active");
    if (scroll) mark.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  updateSearchCount();
}

// Finds all matches. keepPosition = true keeps the current match (used when new messages arrive)
function runChatSearch(keepPosition) {
  const oldIndex = chatMatchIndex;
  clearHighlights();

  const query = chatSearchInput.value.trim().toLowerCase();
  if (!query) {
    updateSearchCount();
    return;
  }

  // Messages that could not be decrypted (.failed) are skipped
  for (const textEl of messagesEl.querySelectorAll(".bubble:not(.failed) .msg-text")) {
    for (const mark of highlightInElement(textEl, query)) chatMatches.push(mark);
  }

  if (chatMatches.length === 0) {
    updateSearchCount();
    return;
  }

  // Start at the newest match (like WhatsApp). When refreshing, stay where we were.
  const index = keepPosition && oldIndex >= 0 ? Math.min(oldIndex, chatMatches.length - 1) : chatMatches.length - 1;
  setActiveMatch(index, !keepPosition);
}

// Waits a moment so many new messages only cause one refresh
function scheduleSearchRefresh() {
  clearTimeout(chatSearchRefreshTimer);
  chatSearchRefreshTimer = setTimeout(() => {
    if (chatSearchOpen) runChatSearch(true);
  }, 50);
}

// direction -1 = older match (up arrow), +1 = newer match (down arrow)
function stepMatch(direction) {
  if (chatMatches.length === 0) return;
  const next = (chatMatchIndex + direction + chatMatches.length) % chatMatches.length;
  setActiveMatch(next, true);
}

function openChatSearch() {
  if (!currentChat) return;
  chatSearchOpen = true;
  chatSearchBar.classList.remove("hidden");
  chatSearchInput.focus();
  chatSearchInput.select();
  if (chatSearchInput.value.trim()) runChatSearch(false);
  else updateSearchCount();
}

// Closes the bar, empties it and removes all highlights
function closeChatSearch() {
  clearTimeout(chatSearchRefreshTimer);
  chatSearchOpen = false;
  chatSearchBar.classList.add("hidden");
  clearHighlights();
  chatSearchInput.value = "";
  updateSearchCount();
}

// =====================================================
// OPEN / CLOSE a chat
// =====================================================

async function openChat(user) {
  clearSearch();
  searchInput.value = "";

  // Same chat already open? Just show it (useful on mobile).
  if (currentChat && currentChat.id === user.id) {
    app.classList.add("show-chat");
    return;
  }

  stopTypingNow();
  closeChatSearch(); // BATCH A: a search belongs to one chat only
  const thisOpen = ++openCounter;
  currentChat = { id: user.id, username: user.username };
  chatReady = false;
  pendingIncoming = [];

  // Clear the unread badge right away
  const conv = conversations.get(user.id);
  if (conv) {
    conv.unread = 0;
    conv.markedUnread = false; // BATCH A: opening a chat removes "marked as unread" (server does it on mark-read)
  }

  // Show the chat window
  placeholder.classList.add("hidden");
  chatWindow.classList.remove("hidden");
  app.classList.add("show-chat");
  resetMessages();
  messagesEl.appendChild(el("div", "loading-note", "Loading messages..."));
  messageInput.value = "";
  autoGrowInput();
  updateHeader();
  renderConversations();

  // 1) get their public key  2) get the old (encrypted) messages
  let info;
  let history;
  try {
    info = await getUserInfo(user.id);
    history = await apiGet("/api/messages/" + user.id);
  } catch (err) {
    if (thisOpen !== openCounter) return;
    resetMessages();
    messagesEl.appendChild(el("div", "loading-note", "Could not load chat: " + err.message));
    return;
  }
  if (thisOpen !== openCounter) return;   // user already opened another chat

  // 3) decrypt every message here in the browser
  const texts = await Promise.all(history.map((m) => safeDecrypt(m, info.publicKey)));
  if (thisOpen !== openCounter) return;

  resetMessages();
  history.forEach((m, i) => {
    const text = texts[i];
    addMessage({
      id: m.id,
      mine: m.from === me.id,
      text: text === null ? DECRYPT_ERROR_TEXT : text,
      failed: text === null,
      createdAt: m.createdAt,
      status: m.status,
      reactions: m.reactions || [], // BATCH A: reactions come with the history
    });
  });

  chatReady = true;
  updateHeader();
  scrollToBottom();

  // Messages that arrived while we were loading
  const waiting = pendingIncoming;
  pendingIncoming = [];
  for (const m of waiting) await handleReceive(m);
  if (thisOpen !== openCounter) return;

  // Tell the server we read everything from this user
  socket.emit("mark-read", { from: user.id });

  if (window.matchMedia("(min-width: 701px)").matches) messageInput.focus();
}

// Used by the Back button on small screens
function closeChat() {
  stopTypingNow();
  closeChatSearch(); // BATCH A
  openCounter++;
  currentChat = null;
  chatReady = false;
  pendingIncoming = [];
  resetMessages();
  chatWindow.classList.add("hidden");
  placeholder.classList.remove("hidden");
  app.classList.remove("show-chat");
  renderConversations();
}

// =====================================================
// SENDING a message
// =====================================================

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !currentChat) return;

  const chat = currentChat;   // remember which chat this message is for
  messageInput.value = "";
  autoGrowInput();
  stopTypingNow();

  // Encrypt in the browser. The server only ever sees the encrypted text.
  let encrypted;
  try {
    const info = await getUserInfo(chat.id);
    encrypted = await encryptMessage(text, info.publicKey);
  } catch (err) {
    messageInput.value = text;   // give the text back so it is not lost
    autoGrowInput();
    showToast("Could not encrypt the message: " + err.message);
    return;
  }

  // Show the message instantly with a single tick, using a temporary id
  const tempId = "temp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const createdAt = new Date().toISOString();

  if (currentChat && currentChat.id === chat.id) {
    addMessage({ id: tempId, mine: true, text, createdAt, status: "sent" });
    scrollToBottom();
  }

  socket.emit("send", {
    to: chat.id,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    tempId,
  });

  // Move this chat to the top of the list (creates it if it is a new chat)
  touchConversation(chat, createdAt, 0);
}

// The server saved our message: swap the temporary id for the real id
function handleSentAck({ tempId, id, createdAt }) {
  const rec = messageEls.get(tempId);
  if (!rec) return;   // the chat was closed in the meantime
  messageEls.delete(tempId);
  rec.id = id;        // from now on this message can be reacted to
  messageEls.set(id, rec);
  if (createdAt) rec.timeEl.textContent = formatTime(createdAt);

  // A status-update may have arrived before the ack
  const early = earlyStatus.get(id);
  if (early) {
    earlyStatus.delete(id);
    applyStatus(id, early);
  }
}

// =====================================================
// RECEIVING a message
// =====================================================

async function handleReceive(msg) {
  const otherId = msg.from;
  setTyping(otherId, false);   // they sent a message, so they stopped typing

  // BATCH A: a new message brings an archived chat back (same rule as the server:
  // muted chats stay archived)
  const known = conversations.get(otherId);
  if (known && known.archived && !isMuted(known)) known.archived = false;

  const viewing = currentChat && currentChat.id === otherId;

  if (viewing && !chatReady) {
    // History is still loading. Keep the message and show it after loading.
    pendingIncoming.push(msg);
    return;
  }

  if (viewing) {
    if (messageEls.has(msg.id)) return;   // already on screen, skip duplicates

    let text = null;
    try {
      const info = await getUserInfo(otherId);
      text = await safeDecrypt(msg, info.publicKey);
    } catch {
      text = null;
    }

    // Is the same chat still open after waiting?
    if (currentChat && currentChat.id === otherId && chatReady) {
      if (messageEls.has(msg.id)) return;
      const wasNearBottom = isNearBottom();
      addMessage({
        id: msg.id,
        mine: false,
        text: text === null ? DECRYPT_ERROR_TEXT : text,
        failed: text === null,
        createdAt: msg.createdAt,
        status: "sent",
      });
      if (wasNearBottom) scrollToBottom();

      socket.emit("mark-read", { from: otherId });
      touchConversation(currentChat, msg.createdAt, 0);
      return;
    }
  }

  // Chat is not open: raise the unread badge and move it to the top.
  // If this is a brand-new conversation we first need the user's name.
  try {
    const info = await getUserInfo(otherId);
    touchConversation({ id: otherId, username: info.username }, msg.createdAt, 1);
  } catch (err) {
    showToast("New message received, but could not load the sender.");
  }
}

// =====================================================
// TYPING indicator
// =====================================================

// Someone else started / stopped typing to us
function setTyping(userId, isTyping) {
  clearTimeout(typingTimers.get(userId));
  if (isTyping) {
    typingUsers.add(userId);
    typingTimers.set(userId, setTimeout(() => setTyping(userId, false), TYPING_EXPIRE_MS));
  } else {
    typingUsers.delete(userId);
    typingTimers.delete(userId);
  }
  if (currentChat && currentChat.id === userId) updateHeader();
  renderConversations();
}

// We are typing: tell the other person (not more than once per second)
function onMessageInput() {
  autoGrowInput();
  if (!currentChat) return;

  if (messageInput.value.trim() === "") {
    stopTypingNow();
    return;
  }

  const now = Date.now();
  if (typingTarget !== currentChat.id || now - lastTypingEmit >= TYPING_THROTTLE_MS) {
    socket.emit("typing", { to: currentChat.id });
    typingTarget = currentChat.id;
    lastTypingEmit = now;
  }

  // If there is no typing for 1.5 seconds, send "stop-typing"
  clearTimeout(stopTypingTimer);
  stopTypingTimer = setTimeout(stopTypingNow, TYPING_STOP_MS);
}

function stopTypingNow() {
  clearTimeout(stopTypingTimer);
  if (typingTarget && socket) socket.emit("stop-typing", { to: typingTarget });
  typingTarget = null;
  lastTypingEmit = 0;
}

// Makes the text box taller when there are many lines
function autoGrowInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
}

// =====================================================
// ONLINE / OFFLINE
// =====================================================

function refreshPresenceUI() {
  updateHeader();
  renderConversations();
}

// =====================================================
// START EVERYTHING
// =====================================================

function startApp() {
  // Read who I am (saved by the login page)
  try {
    me = JSON.parse(sessionStorage.getItem("user")) || me;
  } catch {
    // ignore broken data
  }
  myName.textContent = me.username || "";
  myAvatar.textContent = (me.username || "?").charAt(0).toUpperCase();

  // Connect to the server for live updates
  socket = connectSocket();

  // List of users who are online (sent once right after connecting)
  socket.on("online-users", (ids) => {
    onlineUsers = new Set(ids);
    refreshPresenceUI();
  });

  // Someone came online or went offline
  socket.on("presence", ({ userId, online, lastSeen }) => {
    if (online) {
      onlineUsers.add(userId);
    } else {
      onlineUsers.delete(userId);
      typingUsers.delete(userId);
    }
    if (lastSeen) lastSeenMap.set(userId, lastSeen);
    refreshPresenceUI();
  });

  socket.on("receive", handleReceive);
  socket.on("sent-ack", handleSentAck);
  socket.on("status-update", ({ id, status }) => applyStatus(id, status));
  socket.on("typing", ({ from }) => setTyping(from, true));
  socket.on("stop-typing", ({ from }) => setTyping(from, false));
  socket.on("reaction-update", handleReactionUpdate); // BATCH A

  // Buttons and inputs
  searchInput.addEventListener("input", onSearchInput);
  sendBtn.addEventListener("click", sendMessage);
  messageInput.addEventListener("input", onMessageInput);
  messageInput.addEventListener("keydown", (e) => {
    // Enter = send, Shift+Enter = new line
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  backBtn.addEventListener("click", closeChat);
  logoutBtn.addEventListener("click", () => {
    disconnectSocket();
    sessionStorage.clear();
    window.location.href = "index.html";
  });

  // BATCH A: search-in-chat buttons and input
  chatSearchBtn.addEventListener("click", () => {
    if (chatSearchOpen) closeChatSearch();
    else openChatSearch();
  });
  chatSearchClose.addEventListener("click", closeChatSearch);
  chatSearchPrev.addEventListener("click", () => stepMatch(-1)); // older
  chatSearchNext.addEventListener("click", () => stepMatch(1));  // newer
  chatSearchInput.addEventListener("input", () => runChatSearch(false));
  chatSearchInput.addEventListener("keydown", (e) => {
    // Enter = older match, Shift+Enter = newer match
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      stepMatch(e.shiftKey ? 1 : -1);
    }
  });
  updateSearchCount();

  // BATCH A: close the ⋮ dropdown and the emoji row when clicking outside,
  // pressing Escape, scrolling the list or resizing the window
  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.el.contains(e.target)) closeMenu();
    if (openPicker && !openPicker.el.contains(e.target)) closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeMenu();
    if (openPicker) {
      closePicker(); // first Esc closes the emoji row only
      return;
    }
    if (chatSearchOpen) closeChatSearch(); // Esc closes the search bar and removes highlights
  });
  conversationList.addEventListener("scroll", closeMenu);
  messagesEl.addEventListener("scroll", closePicker);
  window.addEventListener("resize", closeMenu);

  loadConversations();
}

// Not logged in? Go to the login page. Otherwise start the app.
// (This is at the bottom so everything above is ready before it runs.)
if (!sessionStorage.getItem("token")) {
  window.location.replace("index.html");
} else {
  startApp();
}