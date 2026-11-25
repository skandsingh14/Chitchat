// =====================================================
// socket.js - the live (Socket.IO) connection (Part C)
// =====================================================
// The page must load <script src="/socket.io/socket.io.js"></script> first.
// That script gives us the global function `io`.

let socket = null;   // we keep only ONE socket for the whole page

// Creates the socket the first time, and returns the same one after that
export function connectSocket() {
  if (socket) return socket;

  if (typeof io === "undefined") {
    throw new Error("Socket.IO script is not loaded. Add /socket.io/socket.io.js to the page.");
  }

  // The server checks this token before it accepts the connection
  const token = sessionStorage.getItem("token");
  socket = io({ auth: { token } });
  return socket;
}

// Returns the existing socket (or null if connectSocket() was not called yet)
export function getSocket() {
  return socket;
}

// Closes the connection (used when logging out)
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}