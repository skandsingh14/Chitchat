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
//   8. [DELETE MSG] Delete a message for me / for everyone
//   9. [HEADER MENU] One ⋮ menu in the chat header (Search + Disappearing soon)
//  10. [FRIENDS] Friends list: floating + button, panel, add / remove
//  11. [THEME + USER MENU] Dark theme toggle + sidebar ⋮ menu (Dark theme / Logout)

import { apiGet, apiPost, apiPatch, apiDelete } from "./api.js";
import { encryptMessage, decryptMessage } from "./crypto.js";
import { connectSocket, disconnectSocket } from "./socket.js";

// =====================================================
// THEME (sabse pehle chalta hai, app render hone se pehle)
// =====================================================
const THEME_KEY = "theme"; // localStorage key: "dark" ya "light"

// Saved theme padho (localStorage band ho to "light")
function readSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

// Theme lagao: body pe "dark" class on/off
function applyTheme(theme) {
  if (!document.body) return;
  document.body.classList.toggle("dark", theme === "dark");
}

function isDarkTheme() {
  return !!document.body && document.body.classList.contains("dark");
}

// Toggle karo aur choice save karo
function toggleTheme() {
  const next = isDarkTheme() ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // storage band hai, koi baat nahi
  }
}

applyTheme(readSavedTheme());

// ---------- Small settings ----------
const DECRYPT_ERROR_TEXT = "Message decrypt nahi ho paya";
const SEARCH_DEBOUNCE_MS = 300;
const TYPING_THROTTLE_MS = 1000;
const TYPING_STOP_MS = 1500;
const TYPING_EXPIRE_MS = 5000;

// The 6 quick emojis shown when you click the 😀 button
const QUICK_EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F64F}"];

// Used so a status never goes backwards (read -> sent is not allowed)
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

// ---------- Page elements ----------
const $ = (id) => document.getElementById(id);
const app = $("app");
const sidebar = $("sidebar");
const myName = $("myName");
const userMenuBtn = $("userMenuBtn"); // sidebar ka ⋮ button (pehle logoutBtn tha)
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

// Header ⋮ menu button (pehle yahan chatSearchBtn tha)
const chatMenuBtn = $("chatMenuBtn");

// Search-in-chat elements
const chatSearchBar = $("chatSearchBar");
const chatSearchInput = $("chatSearchInput");
const chatSearchCount = $("chatSearchCount");
const chatSearchPrev = $("chatSearchPrev");
const chatSearchNext = $("chatSearchNext");
const chatSearchClose = $("chatSearchClose");

// ---------- App data ----------
let me = { id: "", username: "" };
let socket = null;

// userId -> { user:{id,username}, lastAt, unread, pinned, archived, mutedUntil, markedUnread }
const conversations = new Map();
let onlineUsers = new Set();
const lastSeenMap = new Map();
const typingUsers = new Set();
const typingTimers = new Map();
const userInfoCache = new Map();

// FRIENDS: userId -> { id, username }  (newest pehle)
const friends = new Map();
let friendsOpen = false;
let friendsPanel = null;   // panel (createElement se banta hai)
let friendsList = null;    // panel ke andar <ul>
let friendsFab = null;     // floating + button

let currentChat = null;
let openCounter = 0;
let chatReady = false;
let pendingIncoming = [];

// messageId -> { id, mine, row, wrap, textEl, timeEl, tickEl, status, reactions, reactionsEl }
const messageEls = new Map();
const deletedIds = new Set();           // DELETE MSG: ids of deleted messages
const earlyStatus = new Map();
let lastDateKey = "";

// typing (what WE send to others)
let typingTarget = null;
let lastTypingEmit = 0;
let stopTypingTimer = null;

// search
let searchTimer = null;
let searchSeq = 0;

// chat-list menu state (also used by the message menu, the header menu and the user menu)
let showArchived = false;
let openMenu = null;                    // { el, id }

// reaction picker state
let openPicker = null;                  // { el, wrap }

// search-in-chat state
let chatSearchOpen = false;
let chatMatches = [];
let chatMatchIndex = -1;
let chatSearchRefreshTimer = null;

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

// A message that is still waiting for the server has a temporary id
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

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dateLabel(iso) {
  const d = new Date(iso);
  if (sameDay(d, new Date())) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

function formatListTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (sameDay(d, new Date())) return formatTime(iso);
  if (isYesterday(d)) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

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

// ---------- Avatar ----------
function makeAvatar(username, online) {
  const wrap = el("div", "avatar-wrap");
  wrap.appendChild(el("div", "avatar", (username || "?").charAt(0).toUpperCase()));
  if (online) wrap.appendChild(el("span", "online-dot"));
  return wrap;
}

// ---------- Getting info about another user (cached) ----------
function getUserInfo(userId) {
  if (!userInfoCache.has(userId)) {
    const promise = apiGet("/api/users/" + userId).then((user) => {
      if (user.lastSeen && !lastSeenMap.has(userId)) lastSeenMap.set(userId, user.lastSeen);
      return user;
    });
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

function isMuted(conv) {
  return !!conv.mutedUntil && new Date(conv.mutedUntil) > new Date();
}

function sortConversations(list) {
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return timeValue(b.lastAt) - timeValue(a.lastAt);
  });
}

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

function buildConversationRow(conv) {
  const id = conv.user.id;
  const muted = isMuted(conv);
  const isActive = currentChat && currentChat.id === id;
  const item = el("li", "user-item" + (isActive ? " active" : "") + (conv.archived ? " archived-item" : ""));
  item.tabIndex = 0;

  item.appendChild(makeAvatar(conv.user.username, onlineUsers.has(id)));

  const body = el("div", "user-body");

  const top = el("div", "user-row");
  const nameGroup = el("div", "name-group");
  nameGroup.appendChild(el("span", "user-name", conv.user.username));
  if (conv.pinned) nameGroup.appendChild(el("span", "conv-icon", "\u{1F4CC}"));
  if (muted) nameGroup.appendChild(el("span", "conv-icon", "\u{1F515}"));
  top.appendChild(nameGroup);
  top.appendChild(el("span", "conv-time" + (conv.unread > 0 ? " unread" : ""), formatListTime(conv.lastAt)));
  body.appendChild(top);

  const bottom = el("div", "user-row");
  if (typingUsers.has(id)) {
    bottom.appendChild(el("span", "conv-preview typing", "typing..."));
  } else {
    bottom.appendChild(el("span", "conv-preview", "\u{1F512} Encrypted message"));
  }
  if (conv.unread > 0) {
    bottom.appendChild(
      el("span", "badge" + (muted ? " muted" : ""), conv.unread > 99 ? "99+" : String(conv.unread))
    );
  } else if (conv.markedUnread) {
    bottom.appendChild(el("span", "unread-dot"));
  }
  body.appendChild(bottom);

  item.appendChild(body);

  const menuBtn = el("button", "menu-btn", "\u22EE");
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", "Chat options");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(id, menuBtn);
  });
  item.appendChild(menuBtn);

  item.addEventListener("click", () => openChat(conv.user));
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === item) openChat(conv.user);
  });
  return item;
}

function renderConversations() {
  const all = Array.from(conversations.values());
  const mainList = sortConversations(all.filter((c) => !c.archived));
  const archivedList = sortConversations(all.filter((c) => c.archived));

  if (archivedList.length === 0) showArchived = false;

  conversationList.replaceChildren();

  if (mainList.length === 0 && archivedList.length === 0) {
    conversationList.appendChild(el("li", "empty-note", "No chats yet. Search for a user to start."));
    return;
  }

  if (archivedList.length > 0) {
    conversationList.appendChild(buildArchivedRow(archivedList.length));
    if (showArchived) {
      for (const conv of archivedList) conversationList.appendChild(buildConversationRow(conv));
    }
  }

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
      pinned: false,
      archived: false,
      mutedUntil: null,
      markedUnread: false,
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
        pinned: !!c.pinned,
        archived: !!c.archived,
        mutedUntil: c.mutedUntil || null,
        markedUnread: !!c.markedUnread,
      });
    }
  } catch (err) {
    showToast("Could not load chats: " + err.message);
  }
  renderConversations();
}

// =====================================================
// FRIENDS: list, panel, add / remove
// =====================================================

// Friends panel + floating "+" button banata hai (sirf createElement, innerHTML nahi)
function buildFriendsUI() {
  if (!sidebar) return;

  // Floating "+" button
  friendsFab = el("button", "friends-fab", "+");
  friendsFab.type = "button";
  friendsFab.setAttribute("aria-label", "Friends");
  friendsFab.addEventListener("click", openFriends);
  sidebar.appendChild(friendsFab);

  // Panel: header (← Friends) + list
  friendsPanel = el("div", "friends-panel hidden");

  const header = el("div", "friends-header");
  const backFriends = el("button", "friends-back", "\u2190");
  backFriends.type = "button";
  backFriends.setAttribute("aria-label", "Back to chats");
  backFriends.addEventListener("click", closeFriends);
  header.appendChild(backFriends);
  header.appendChild(el("span", "friends-title", "Friends"));
  friendsPanel.appendChild(header);

  friendsList = el("ul", "user-list friends-list");
  friendsPanel.appendChild(friendsList);

  sidebar.appendChild(friendsPanel);
}

function openFriends() {
  if (!friendsPanel) return;
  closeMenu();
  friendsOpen = true;
  sidebar.classList.add("friends-open");
  friendsPanel.classList.remove("hidden");
  if (friendsFab) friendsFab.classList.add("hidden");
  renderFriends();
}

function closeFriends() {
  if (!friendsPanel) return;
  friendsOpen = false;
  sidebar.classList.remove("friends-open");
  friendsPanel.classList.add("hidden");
  if (friendsFab) friendsFab.classList.remove("hidden");
}

// Ek friend ki row
function buildFriendRow(friend) {
  const item = el("li", "user-item friend-row");
  item.tabIndex = 0;

  item.appendChild(makeAvatar(friend.username, onlineUsers.has(friend.id)));

  const body = el("div", "user-body");
  body.appendChild(el("span", "user-name", friend.username));
  item.appendChild(body);

  // ✕ remove button
  const removeBtn = el("button", "friend-remove", "\u2715");
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "Remove friend");
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // row click (chat open) na ho
    removeFriend(friend.id, friend.username);
  });
  item.appendChild(removeBtn);

  // Row click: chat kholo (conversation na ho tab bhi chalega)
  const open = () => openChat({ id: friend.id, username: friend.username });
  item.addEventListener("click", open);
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === item) open();
  });
  return item;
}

function renderFriends() {
  if (!friendsList) return;
  friendsList.replaceChildren();

  if (friends.size === 0) {
    friendsList.appendChild(el("li", "empty-note", "No friends yet. Add from the chat menu."));
    return;
  }

  for (const friend of friends.values()) friendsList.appendChild(buildFriendRow(friend));
}

async function loadFriends() {
  try {
    const list = await apiGet("/api/friends");
    friends.clear();
    for (const f of list) friends.set(f.id, { id: f.id, username: f.username });
  } catch (err) {
    showToast("Could not load friends: " + err.message);
  }
  renderFriends();
}

async function addFriend(user) {
  try {
    const res = await apiPost("/api/friends/" + user.id, {});
    const f = res && res.friend ? res.friend : user;

    // Newest pehle: naya entry sabse upar
    const old = Array.from(friends.values()).filter((x) => x.id !== f.id);
    friends.clear();
    friends.set(f.id, { id: f.id, username: f.username });
    for (const x of old) friends.set(x.id, x);

    renderFriends();
    showToast("Added to friends");
  } catch (err) {
    showToast(err.message);
  }
}

// Sirf friends list se hatata hai. conversations Map / messages ko haath nahi lagata.
function confirmRemoveFriend(username) {
  return new Promise((resolve) => {
    const dialog = el("dialog", "confirm-dialog");
    const content = el("div", "confirm-dialog-content");
    const icon = el("div", "confirm-icon", "!");
    icon.setAttribute("aria-hidden", "true");
    const title = el("h2", "", "Remove friend?");
    const message = el("p", "", "Are you sure you want to remove " + (username || "this friend") + " from your friends list?");
    const actions = el("div", "confirm-actions");
    const cancelBtn = el("button", "confirm-cancel", "No, keep");
    const removeBtn = el("button", "confirm-remove", "Yes, remove");
    cancelBtn.type = "button";
    removeBtn.type = "button";
    actions.append(cancelBtn, removeBtn);
    content.append(icon, title, message, actions);
    dialog.appendChild(content);
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(confirmed);
    };
    cancelBtn.addEventListener("click", () => finish(false));
    removeBtn.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(false);
    });
    dialog.showModal();
    cancelBtn.focus();
  });
}

async function removeFriend(id, username) {
  closeMenu();
  if (!(await confirmRemoveFriend(username))) return;
  try {
    await apiDelete("/api/friends/" + id);
    friends.delete(id);
    renderFriends();
    showToast("Removed from friends");
  } catch (err) {
    showToast(err.message);
  }
}

// =====================================================
// Chat-list menu (⋮) and its actions
// =====================================================

function closeMenu() {
  if (openMenu) {
    openMenu.el.remove();
    openMenu = null;
  }
}

// One clickable line inside a dropdown
function menuItem(label, onClick, danger) {
  const btn = el("button", "menu-item" + (danger ? " danger" : ""), label);
  btn.type = "button";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// Puts a dropdown on <body> under a button, inside the screen
function placeMenu(menu, anchorBtn) {
  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  let left = rect.right - menu.offsetWidth;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menu.offsetHeight - 4);
  }
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

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

  placeMenu(menu, anchorBtn);
  openMenu = { el: menu, id };
}

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
    alert(err.message);
  }
}

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
    if (currentChat && currentChat.id === id) {
      closeChatSearch();
      resetMessages();
    }
    renderConversations();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteChat(id) {
  closeMenu();
  if (!window.confirm("Delete this chat?")) return;
  try {
    await apiDelete("/api/chats/" + id);
    conversations.delete(id);
    if (currentChat && currentChat.id === id) {
      closeChat();
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
  searchSeq++;
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
    if (mySeq !== searchSeq) return;
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
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

// =====================================================
// CHAT HEADER
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
  closePicker();
  messagesEl.replaceChildren();
  messageEls.clear();
  earlyStatus.clear();
  lastDateKey = "";
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

function paintTick(rec) {
  if (!rec.tickEl) return;
  rec.tickEl.textContent = rec.status === "sent" ? "\u2713" : "\u2713\u2713";
  rec.tickEl.classList.toggle("read", rec.status === "read");
}

// =====================================================
// Reactions
// =====================================================

function myReactionOf(rec) {
  const mine = rec.reactions.find((r) => String(r.user) === me.id);
  return mine ? mine.emoji : "";
}

function renderReactions(rec) {
  rec.reactionsEl.replaceChildren();

  const groups = new Map();
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

function sendReaction(rec, emoji) {
  if (isTempId(rec.id)) {
    showToast("Please wait, the message is still sending.");
    return;
  }
  const newEmoji = myReactionOf(rec) === emoji ? "" : emoji;
  socket.emit("react", { messageId: rec.id, emoji: newEmoji });
}

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
  rec.wrap.classList.add("show-actions");
  openPicker = { el: picker, wrap: rec.wrap };
}

function handleReactionUpdate({ id, reactions }) {
  const rec = messageEls.get(id);
  if (!rec) return;
  const wasNearBottom = isNearBottom();
  rec.reactions = Array.isArray(reactions) ? reactions : [];
  renderReactions(rec);
  if (wasNearBottom) scrollToBottom();

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
  row.dataset.dateKey = key; // DELETE MSG: used to fix the date separator after a delete

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

  // The small 😀 button (shows on hover, or after a tap on phones)
  const reactBtn = el("button", "react-btn", "\u{1F600}");
  reactBtn.type = "button";
  reactBtn.setAttribute("aria-label", "React to message");
  reactBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePicker(rec);
  });
  wrap.appendChild(reactBtn);

  // DELETE MSG: the small ⋮ button
  const msgMenuBtn = el("button", "msg-menu-btn", "\u22EE");
  msgMenuBtn.type = "button";
  msgMenuBtn.setAttribute("aria-label", "Message options");
  msgMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMessageMenu(rec, msgMenuBtn);
  });
  wrap.appendChild(msgMenuBtn);

  // On touch screens a tap on the bubble shows the buttons
  bubble.addEventListener("click", () => {
    if (!window.matchMedia("(hover: none)").matches) return;
    const wasShown = wrap.classList.contains("show-actions");
    closePicker();
    for (const w of messagesEl.querySelectorAll(".msg-wrap.show-actions")) {
      w.classList.remove("show-actions");
    }
    if (!wasShown) wrap.classList.add("show-actions");
  });

  if (chatSearchOpen && chatSearchInput.value.trim()) scheduleSearchRefresh();

  return rec;
}

// Changes the ticks of a message (only moves forward)
function applyStatus(id, status) {
  const rec = messageEls.get(id);
  if (!rec) {
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
// Search inside the open chat
// =====================================================

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

function clearHighlights() {
  const parents = new Set();
  for (const mark of messagesEl.querySelectorAll(".msg-text mark")) parents.add(mark.parentNode);
  for (const p of parents) p.textContent = p.textContent;
  chatMatches = [];
  chatMatchIndex = -1;
}

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

function runChatSearch(keepPosition) {
  const oldIndex = chatMatchIndex;
  clearHighlights();

  const query = chatSearchInput.value.trim().toLowerCase();
  if (!query) {
    updateSearchCount();
    return;
  }

  for (const textEl of messagesEl.querySelectorAll(".bubble:not(.failed) .msg-text")) {
    for (const mark of highlightInElement(textEl, query)) chatMatches.push(mark);
  }

  if (chatMatches.length === 0) {
    updateSearchCount();
    return;
  }

  const index = keepPosition && oldIndex >= 0 ? Math.min(oldIndex, chatMatches.length - 1) : chatMatches.length - 1;
  setActiveMatch(index, !keepPosition);
}

function scheduleSearchRefresh() {
  clearTimeout(chatSearchRefreshTimer);
  chatSearchRefreshTimer = setTimeout(() => {
    if (chatSearchOpen) runChatSearch(true);
  }, 50);
}

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

function closeChatSearch() {
  clearTimeout(chatSearchRefreshTimer);
  chatSearchOpen = false;
  chatSearchBar.classList.add("hidden");
  clearHighlights();
  chatSearchInput.value = "";
  updateSearchCount();
}

// =====================================================
// HEADER MENU: ⋮ button in the chat header
// =====================================================

function toggleChatMenu(anchorBtn) {
  const menuId = "header-menu";
  const wasOpen = openMenu && openMenu.id === menuId;
  closeMenu();
  closePicker();
  if (wasOpen) return;
  if (!currentChat) return; // menu sirf tab jab chat khula ho

  const menu = el("div", "chat-menu");

  // "Search": pehle wale 🔍 button jaisa hi kaam (toggle)
  menu.appendChild(
    menuItem("Search", () => {
      closeMenu();
      if (chatSearchOpen) closeChatSearch();
      else openChatSearch();
    })
  );

  // FRIENDS: "Add to friends" ya "Remove friend" (jo user abhi khula hai)
  const chatUser = { id: currentChat.id, username: currentChat.username };
  if (friends.has(chatUser.id)) {
    menu.appendChild(
      menuItem("Remove friend", () => removeFriend(chatUser.id, chatUser.username), true)
    );
  } else {
    menu.appendChild(
      menuItem("Add to friends", () => {
        closeMenu();
        addFriend(chatUser);
      })
    );
  }

  // "Disappearing messages": abhi disabled, kuch nahi karta
  const soon = menuItem("Disappearing messages", () => {});
  soon.disabled = true;
  soon.appendChild(el("span", "menu-soon", "Coming soon"));
  menu.appendChild(soon);

  placeMenu(menu, anchorBtn);
  openMenu = { el: menu, id: menuId };
}

// =====================================================
// USER MENU: sidebar header ka ⋮ (Dark theme + Logout)
// =====================================================

// Logout: bilkul purane logout button jaisa
function doLogout() {
  disconnectSocket();
  sessionStorage.clear();
  window.location.href = "index.html";
}

function toggleUserMenu(anchorBtn) {
  const menuId = "user-menu";
  const wasOpen = openMenu && openMenu.id === menuId;
  closeMenu();
  closePicker();
  if (wasOpen) return;

  const menu = el("div", "chat-menu");

  // Dark theme: label me abhi ki state dikhti hai (On / Off)
  menu.appendChild(
    menuItem("Dark theme: " + (isDarkTheme() ? "On" : "Off"), () => {
      closeMenu();
      toggleTheme();
    })
  );

  // Logout (danger style)
  menu.appendChild(
    menuItem(
      "Logout",
      () => {
        closeMenu();
        doLogout();
      },
      true
    )
  );

  placeMenu(menu, anchorBtn);
  openMenu = { el: menu, id: menuId };
}

// =====================================================
// DELETE MSG: delete for me / delete for everyone
// =====================================================

function toggleMessageMenu(rec, anchorBtn) {
  const menuId = "msg:" + rec.id;
  const wasOpen = openMenu && openMenu.id === menuId;
  closeMenu();
  closePicker();
  if (wasOpen) return;

  if (isTempId(rec.id)) {
    showToast("Please wait, the message is still sending.");
    return;
  }

  const menu = el("div", "chat-menu");
  menu.appendChild(menuItem("Delete for me", () => deleteMessageForMe(rec), true));
  if (rec.mine) {
    menu.appendChild(menuItem("Delete for everyone", () => deleteMessageForEveryone(rec), true));
  }
  placeMenu(menu, anchorBtn);
  openMenu = { el: menu, id: menuId };
}

function deleteMessageForMe(rec) {
  closeMenu();
  socket.emit("delete-for-me", { messageId: rec.id }, (res) => {
    if (res && res.error) showToast(res.error);
  });
}

function deleteMessageForEveryone(rec) {
  closeMenu();
  if (!window.confirm("Delete this message for everyone?")) return;
  socket.emit("delete-for-everyone", { messageId: rec.id }, (res) => {
    if (res && res.error) showToast(res.error);
  });
}

// Removes a message from the screen (and an empty date separator)
function removeMessageFromScreen(id) {
  const rec = messageEls.get(id);
  if (!rec) return;
  if (openPicker && openPicker.wrap === rec.wrap) closePicker();

  const prev = rec.row.previousElementSibling;
  const next = rec.row.nextElementSibling;
  rec.row.remove();
  messageEls.delete(id);

  if (prev && prev.classList.contains("date-sep") && (!next || next.classList.contains("date-sep"))) {
    prev.remove();
  }

  const rows = messagesEl.querySelectorAll(".msg-row");
  lastDateKey = rows.length ? rows[rows.length - 1].dataset.dateKey || "" : "";

  if (chatSearchOpen && chatSearchInput.value.trim()) scheduleSearchRefresh();
}

// Server: message deleted for everyone
function handleMessageDeleted({ id, from, wasUnread }) {
  deletedIds.add(id);
  removeMessageFromScreen(id);

  // If it was an unread message sent to me, lower the badge by one
  if (from !== me.id && wasUnread) {
    const conv = conversations.get(from);
    if (conv && conv.unread > 0) conv.unread--;
    renderConversations();
  }
}

// Server: message hidden only for me
function handleMessageHidden({ id }) {
  deletedIds.add(id);
  removeMessageFromScreen(id);
}

// =====================================================
// OPEN / CLOSE a chat
// =====================================================

async function openChat(user) {
  clearSearch();
  searchInput.value = "";

  if (currentChat && currentChat.id === user.id) {
    app.classList.add("show-chat");
    return;
  }

  stopTypingNow();
  closeChatSearch();
  const thisOpen = ++openCounter;
  currentChat = { id: user.id, username: user.username };
  chatReady = false;
  pendingIncoming = [];

  const conv = conversations.get(user.id);
  if (conv) {
    conv.unread = 0;
    conv.markedUnread = false;
  }

  placeholder.classList.add("hidden");
  chatWindow.classList.remove("hidden");
  app.classList.add("show-chat");
  resetMessages();
  messagesEl.appendChild(el("div", "loading-note", "Loading messages..."));
  messageInput.value = "";
  autoGrowInput();
  updateHeader();
  renderConversations();

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
  if (thisOpen !== openCounter) return;

  const texts = await Promise.all(history.map((m) => safeDecrypt(m, info.publicKey)));
  if (thisOpen !== openCounter) return;

  resetMessages();
  history.forEach((m, i) => {
    if (deletedIds.has(m.id)) return; // DELETE MSG: skip deleted messages
    const text = texts[i];
    addMessage({
      id: m.id,
      mine: m.from === me.id,
      text: text === null ? DECRYPT_ERROR_TEXT : text,
      failed: text === null,
      createdAt: m.createdAt,
      status: m.status,
      reactions: m.reactions || [],
    });
  });

  chatReady = true;
  updateHeader();
  scrollToBottom();

  const waiting = pendingIncoming;
  pendingIncoming = [];
  for (const m of waiting) await handleReceive(m);
  if (thisOpen !== openCounter) return;

  socket.emit("mark-read", { from: user.id });

  if (window.matchMedia("(min-width: 701px)").matches) messageInput.focus();
}

function closeChat() {
  stopTypingNow();
  closeChatSearch();
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

  const chat = currentChat;
  messageInput.value = "";
  autoGrowInput();
  stopTypingNow();

  let encrypted;
  try {
    const info = await getUserInfo(chat.id);
    encrypted = await encryptMessage(text, info.publicKey);
  } catch (err) {
    messageInput.value = text;
    autoGrowInput();
    showToast("Could not encrypt the message: " + err.message);
    return;
  }

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

  touchConversation(chat, createdAt, 0);
}

function handleSentAck({ tempId, id, createdAt }) {
  const rec = messageEls.get(tempId);
  if (!rec) return;
  messageEls.delete(tempId);
  rec.id = id;
  messageEls.set(id, rec);
  if (createdAt) rec.timeEl.textContent = formatTime(createdAt);

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
  if (deletedIds.has(msg.id)) return; // DELETE MSG: already deleted

  const otherId = msg.from;
  setTyping(otherId, false);

  const known = conversations.get(otherId);
  if (known && known.archived && !isMuted(known)) known.archived = false;

  const viewing = currentChat && currentChat.id === otherId;

  if (viewing && !chatReady) {
    pendingIncoming.push(msg);
    return;
  }

  if (viewing) {
    if (messageEls.has(msg.id)) return;

    let text = null;
    try {
      const info = await getUserInfo(otherId);
      text = await safeDecrypt(msg, info.publicKey);
    } catch {
      text = null;
    }

    if (deletedIds.has(msg.id)) return; // deleted while we were decrypting

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

  clearTimeout(stopTypingTimer);
  stopTypingTimer = setTimeout(stopTypingNow, TYPING_STOP_MS);
}

function stopTypingNow() {
  clearTimeout(stopTypingTimer);
  if (typingTarget && socket) socket.emit("stop-typing", { to: typingTarget });
  typingTarget = null;
  lastTypingEmit = 0;
}

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
  renderFriends(); // FRIENDS: online dots live update
}

// =====================================================
// START EVERYTHING
// =====================================================

function startApp() {
  try {
    me = JSON.parse(sessionStorage.getItem("user")) || me;
  } catch {
    // ignore broken data
  }
  if (myName) myName.textContent = me.username || "";

  buildFriendsUI(); // FRIENDS: + button aur panel banao

  socket = connectSocket();

  socket.on("online-users", (ids) => {
    onlineUsers = new Set(ids);
    refreshPresenceUI();
  });

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
  socket.on("reaction-update", handleReactionUpdate);
  socket.on("message-deleted", handleMessageDeleted); // DELETE MSG
  socket.on("message-hidden", handleMessageHidden);   // DELETE MSG

  searchInput.addEventListener("input", onSearchInput);
  sendBtn.addEventListener("click", sendMessage);
  messageInput.addEventListener("input", onMessageInput);
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  backBtn.addEventListener("click", closeChat);

  // Sidebar ⋮ menu (Dark theme + Logout). stopPropagation zaroori hai,
  // warna document click turant menu band kar dega
  if (userMenuBtn) {
    userMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleUserMenu(userMenuBtn);
    });
  }

  // Header ⋮ menu (stopPropagation zaroori hai, warna document click turant band kar dega)
  chatMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleChatMenu(chatMenuBtn);
  });
  chatSearchClose.addEventListener("click", closeChatSearch);
  chatSearchPrev.addEventListener("click", () => stepMatch(-1));
  chatSearchNext.addEventListener("click", () => stepMatch(1));
  chatSearchInput.addEventListener("input", () => runChatSearch(false));
  chatSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      stepMatch(e.shiftKey ? 1 : -1);
    }
  });
  updateSearchCount();

  // Close dropdowns / emoji row when clicking outside, pressing Escape, scrolling or resizing
  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.el.contains(e.target)) closeMenu();
    if (openPicker && !openPicker.el.contains(e.target)) closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeMenu();
    if (openPicker) {
      closePicker();
      return;
    }
    if (chatSearchOpen) closeChatSearch();
  });
  conversationList.addEventListener("scroll", closeMenu);
  searchResults.addEventListener("scroll", closeMenu);              // user menu: results scroll pe band
  if (friendsList) friendsList.addEventListener("scroll", closeMenu); // user menu: friends scroll pe band
  messagesEl.addEventListener("scroll", closePicker);
  messagesEl.addEventListener("scroll", closeMenu);   // DELETE MSG + header menu
  window.addEventListener("resize", closeMenu);

  loadConversations();
  loadFriends(); // FRIENDS: ek baar server se list lao
}

// Not logged in? Go to the login page. Otherwise start the app.
if (!sessionStorage.getItem("token")) {
  window.location.replace("index.html");
} else {
  startApp();
}