const crypto = require("crypto");
const express = require("express");
const { pool } = require("./db");
const { requireAdmin } = require("./auth");
const { HttpError, wrap } = require("./util");

// REST resource "skins": list, get by id, create, update, delete.
// Reading is open to every logged-in player, writing is for admins only.
// server.js mounts this router at /api/skins and puts requireAuth in front of it.
const router = express.Router();

// A skin together with the readable data of its rarity (one JOIN instead of two requests).
const SELECT_SKIN = `SELECT s.id, s.name, s.image_url, s.min_float, s.max_float,
       r.code AS rarity, r.name AS rarity_name, r.tier AS rarity_tier
  FROM skins s JOIN rarities r ON r.id = s.rarity_id`;

// Reads ?limit=10 style query parameters: missing -> default, garbage/out of range -> 400.
function intParam(value, name, { def, min, max }) {
  if (value === undefined) return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer ${min}-${max}`);
  return n;
}

// "0.25" or 0.25 -> "0.25000000" (8 digits, the precision of the NUMERIC(9,8) column).
function parseFloatField(value, name) {
  const ok = (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  if (!ok || Number(value) < 0 || Number(value) > 1) throw new HttpError(400, `${name} must be a number between 0 and 1`);
  return Number(value).toFixed(8);
}

// Checks the JSON body of POST/PUT and returns clean values, or throws 400 with a clear message.
// Both create and update need ALL fields (PUT means "replace the whole skin").
async function parseSkinBody(body) {
  const { name, rarity, image_url, min_float, max_float } = body || {};
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100)
    throw new HttpError(400, "name must be a string of 1-100 characters");
  if (typeof rarity !== "string") throw new HttpError(400, "rarity must be a rarity code, e.g. rarity_rare_weapon");
  if (typeof image_url !== "string" || image_url.length > 1000) throw new HttpError(400, "image_url must be a URL string");
  let url;
  try {
    url = new URL(image_url);
  } catch {
    throw new HttpError(400, "image_url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "image_url must start with http:// or https://");

  const min = parseFloatField(min_float, "min_float");
  const max = parseFloatField(max_float, "max_float");
  if (Number(min) > Number(max)) throw new HttpError(400, "min_float can't be greater than max_float");

  const { rows } = await pool.query("SELECT id FROM rarities WHERE code = $1", [rarity]);
  if (!rows[0]) throw new HttpError(400, `Unknown rarity "${rarity}"`);

  return { name: name.trim(), rarityId: rows[0].id, image_url, min, max };
}

async function findSkin(id) {
  const { rows } = await pool.query(`${SELECT_SKIN} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Skin not found");
  return rows[0];
}

// LIST  GET /api/skins?rarity=<code>&q=<text>&limit=20&offset=0
router.get(
  "/",
  wrap(async (req, res) => {
    const limit = intParam(req.query.limit, "limit", { def: 20, min: 1, max: 100 });
    const offset = intParam(req.query.offset, "offset", { def: 0, min: 0, max: 1e6 });

    // Build the WHERE part from the filters that were actually sent. Values never go into the SQL
    // text itself, only as $1, $2... placeholders: that is what protects against SQL injection.
    const where = [];
    const params = [];
    if (typeof req.query.rarity === "string") {
      params.push(req.query.rarity);
      where.push(`r.code = $${params.length}`);
    }
    if (typeof req.query.q === "string" && req.query.q !== "") {
      params.push(`%${req.query.q}%`);
      where.push(`s.name ILIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = await pool.query(
      `SELECT count(*)::int AS n FROM skins s JOIN rarities r ON r.id = s.rarity_id ${whereSql}`,
      params
    );
    const { rows } = await pool.query(
      `${SELECT_SKIN} ${whereSql} ORDER BY r.tier DESC, s.name, s.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ total: total.rows[0].n, limit, offset, items: rows });
  })
);

// GET BY ID  GET /api/skins/:id
router.get(
  "/:id",
  wrap(async (req, res) => {
    res.json(await findSkin(req.params.id));
  })
);

// CREATE  POST /api/skins   (admin)
router.post(
  "/",
  requireAdmin,
  wrap(async (req, res) => {
    const s = await parseSkinBody(req.body);
    // The id is made on the server, same format as the seeded skins: skin-<12 hex characters>.
    const id = `skin-${crypto.randomBytes(6).toString("hex")}`;
    await pool.query(
      "INSERT INTO skins (id, name, rarity_id, image_url, min_float, max_float) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, s.name, s.rarityId, s.image_url, s.min, s.max]
    );
    res.status(201).location(`/api/skins/${id}`).json(await findSkin(id));
  })
);

// UPDATE  PUT /api/skins/:id   (admin) - replaces all editable fields
router.put(
  "/:id",
  requireAdmin,
  wrap(async (req, res) => {
    const s = await parseSkinBody(req.body);
    const result = await pool.query(
      "UPDATE skins SET name = $1, rarity_id = $2, image_url = $3, min_float = $4, max_float = $5 WHERE id = $6",
      [s.name, s.rarityId, s.image_url, s.min, s.max, req.params.id]
    );
    if (result.rowCount === 0) throw new HttpError(404, "Skin not found");
    res.json(await findSkin(req.params.id));
  })
);

// DELETE  DELETE /api/skins/:id   (admin)
// If a player owns this skin, the foreign key from inventory blocks the delete: PostgreSQL raises
// error 23503 and the central error handler in server.js turns it into "409 Conflict".
router.delete(
  "/:id",
  requireAdmin,
  wrap(async (req, res) => {
    const result = await pool.query("DELETE FROM skins WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) throw new HttpError(404, "Skin not found");
    res.status(204).end();
  })
);

module.exports = { router };
