// =====================================================
// api.js - talks to the server's REST API (Part C)
// =====================================================
// apiGet(path)          -> GET request, returns the JSON answer
// apiPost(path, body)   -> POST request with a JSON body, returns the JSON answer
// apiPatch(path, body)  -> PATCH request with a JSON body, returns the JSON answer  [NEW A]
// apiDelete(path)       -> DELETE request, returns the JSON answer                  [NEW A]
// All of them add the login token, and all throw an Error(message) when something goes wrong.

// Does the real work for all the functions
async function request(method, path, body) {
  const headers = { Accept: "application/json" };

  // Send the login token (JWT) if we have one
  const token = sessionStorage.getItem("token");
  if (token) headers.Authorization = "Bearer " + token;

  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  // 1) Send the request
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("Network error. Please check your connection.");
  }

  // 2) Read the JSON answer (it can be empty or not JSON, so we are careful)
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  // 3) 401 = not logged in / token expired: clear everything and go to the login page.
  //    (Not for login/signup: there a 401 only means "Invalid credentials",
  //    and that message must be shown on the login page.)
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    sessionStorage.clear();
    window.location.href = "/index.html";
  }

  // 4) Any error: throw the server's message {error: "..."}
  if (!response.ok) {
    throw new Error((data && data.error) || "Request failed (" + response.status + ")");
  }

  return data;
}

export function apiGet(path) {
  return request("GET", path);
}

export function apiPost(path, body) {
  return request("POST", path, body);
}

// [NEW A] PATCH request with a JSON body (used for pin, archive, mute, mark unread)
export function apiPatch(path, body) {
  return request("PATCH", path, body);
}

// [NEW A] DELETE request, no body (used to delete a chat from my list)
export function apiDelete(path) {
  return request("DELETE", path);
}