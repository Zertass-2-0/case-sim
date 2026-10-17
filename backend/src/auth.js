const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("./config");
const { pool, withTransaction } = require("./db");
const { HttpError, wrap } = require("./util");

const router = express.Router();

const NICK_RE = /^[A-Za-z0-9_]{3,20}$/;

function issueToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: "7d" });
}

router.post(
  "/register",
  wrap(async (req, res) => {
    const { nick, password } = req.body || {};
    if (typeof nick !== "string" || !NICK_RE.test(nick))
      throw new HttpError(400, "Nick must be 3-20 characters: letters, digits, underscore");
    if (typeof password !== "string" || password.length < 6 || password.length > 72)
      throw new HttpError(400, "Password must be 6-72 characters");

    const hash = await bcrypt.hash(password, 10);
    const user = await withTransaction(async (c) => {
      const { rows } = await c.query(
        "INSERT INTO users (nick, password_hash, balance) VALUES ($1,$2,$3) RETURNING id, nick, balance, is_admin",
        [nick, hash, config.startingBalance]
      );
      await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'signup',$2,'Starting capital')", [
        rows[0].id,
        config.startingBalance,
      ]);
      return rows[0];
    });
    res.status(201).json({ token: issueToken(user.id), user });
  })
);

router.post(
  "/login",
  wrap(async (req, res) => {
    const { nick, password } = req.body || {};
    if (typeof nick !== "string" || typeof password !== "string") throw new HttpError(400, "nick and password required");
    const { rows } = await pool.query(
      "SELECT id, nick, balance, is_admin, password_hash FROM users WHERE lower(nick) = lower($1)",
      [nick]
    );
    // same message for "no such user" and "wrong password" so nicks can't be probed
    const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) throw new HttpError(401, "Wrong nick or password");
    const { password_hash, ...user } = rows[0];
    res.json({ token: issueToken(user.id), user });
  })
);

// Middleware: reads "Authorization: Bearer <token>", loads the user fresh from the DB.
const requireAuth = wrap(async (req, _res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Not logged in");
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, "Session expired, log in again");
  }
  const { rows } = await pool.query("SELECT id, nick, balance, is_admin FROM users WHERE id = $1", [payload.sub]);
  if (!rows[0]) throw new HttpError(401, "User no longer exists");
  req.user = rows[0];
  next();
});

const requireAdmin = (req, _res, next) => {
  if (!req.user.is_admin) return next(new HttpError(403, "Admins only"));
  next();
};

module.exports = { router, requireAuth, requireAdmin };
