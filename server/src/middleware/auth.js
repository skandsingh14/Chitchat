import jwt from "jsonwebtoken";

// Checks the login token. Use it on routes that need a logged-in user.
// The client sends:  Authorization: Bearer <jwt>
// On success we set req.userId (a string) and continue.
export default function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = String(payload.id);
    next();
  } catch {
    res.status(401).json({ error: "Missing or invalid token" });
  }
}