const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const config = require("./config");

const pool = new Pool(config.db);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn(client) inside BEGIN/COMMIT. Any thrown error rolls EVERYTHING back,
// so e.g. "take money" and "give item" either both happen or neither does.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM rarities");
  if (rows[0].n > 0) return;

  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "seed.json"), "utf8"));
  await withTransaction(async (c) => {
    const rarityIds = {};
    for (const r of seed.rarities) {
      const res = await c.query(
        "INSERT INTO rarities (code, name, color, tier, drop_weight, base_price) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [r.code, r.name, r.color, r.tier, r.drop_weight, r.base_price]
      );
      rarityIds[r.code] = res.rows[0].id;
    }
    for (const s of seed.skins) {
      await c.query(
        "INSERT INTO skins (id, name, rarity_id, image_url, min_float, max_float) VALUES ($1,$2,$3,$4,$5,$6)",
        [s.id, s.name, rarityIds[s.rarity], s.image, s.min_float, s.max_float]
      );
    }
    for (const cs of seed.cases) {
      const res = await c.query(
        "INSERT INTO cases (name, image_url, price) VALUES ($1,$2,$3) RETURNING id",
        [cs.name, cs.image, cs.price]
      );
      for (const skinId of cs.skins) {
        await c.query("INSERT INTO case_skins (case_id, skin_id) VALUES ($1,$2)", [res.rows[0].id, skinId]);
      }
    }
  });
  console.log("Seeded rarities, skins and cases");
}

async function ensureAdmin() {
  const { nick, password } = config.admin;
  if (!nick || !password) return;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (nick, password_hash, balance, is_admin)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (lower(nick)) DO UPDATE SET is_admin = TRUE`,
    [nick, hash, config.startingBalance]
  );
}

// The DB container may still be starting: retry for ~40 s.
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await pool.query(schema);
      await seedIfEmpty();
      await ensureAdmin();
      console.log("Database ready");
      return;
    } catch (err) {
      console.log(`DB not ready (attempt ${attempt}): ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error("Could not initialise the database");
}

module.exports = { pool, withTransaction, init };
