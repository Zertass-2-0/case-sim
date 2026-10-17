const path = require("path");
const express = require("express");
const config = require("./config");
const db = require("./db");
const auth = require("./auth");
const game = require("./game");
const admin = require("./admin");
const { wrap } = require("./util");

const app = express();
app.use(express.json({ limit: "20kb" }));

// The single-page frontend (plain HTML/CSS/JS) is served by the same container.
app.use(express.static(path.join(__dirname, "..", "public")));

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    await db.pool.query("SELECT 1");
    res.json({ status: "ok" });
  })
);

app.use("/api/auth", auth.router);

app.get("/api/me", auth.requireAuth, (req, res) => res.json(req.user));
app.use("/api", auth.requireAuth, game.router);
app.use("/api/admin", auth.requireAuth, auth.requireAdmin, admin.router);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// Central error handler: HttpError -> its status; known Postgres errors -> friendly 4xx; rest -> 500
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === "23505") return res.status(409).json({ error: "That nick is already taken" });
  if (err.code === "23514") return res.status(400).json({ error: "Operation not allowed (balance can't go below 0)" });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

db.init()
  .then(() => app.listen(config.port, () => console.log(`Case Sim listening on ${config.port}`)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
