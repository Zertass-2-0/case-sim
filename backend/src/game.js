const express = require("express");
const { pool, withTransaction } = require("./db");
const { describePrice } = require("./pricing");
const { HttpError, wrap, randomFloatBetween, pickWeighted, parseIds } = require("./util");

const router = express.Router();

const CONTRACT_SIZE = 10;

async function worldMinFloat(client) {
  const { rows } = await client.query("SELECT min(wear_float) AS m FROM inventory");
  return rows[0].m; // string or null
}

// Turns raw inventory rows (joined with skins + rarities) into API objects with price info.
function toItem(row, worldMin) {
  const info = describePrice(row.base_price, row.wear_float, worldMin);
  return {
    id: row.id,
    skin_id: row.skin_id,
    name: row.name,
    image_url: row.image_url,
    rarity: row.rarity_name,
    rarity_tier: row.tier,
    color: row.color,
    float: row.wear_float,
    wear: info.wear,
    special: info.special,
    price: info.price,
    source: row.source,
    acquired_at: row.acquired_at,
  };
}

const ITEM_COLUMNS = `i.id, i.skin_id, i.wear_float, i.source, i.acquired_at,
  s.name, s.image_url, s.min_float, s.max_float,
  r.name AS rarity_name, r.color, r.tier, r.base_price`;
const ITEM_JOINS = `FROM inventory i JOIN skins s ON s.id = i.skin_id JOIN rarities r ON r.id = s.rarity_id`;

// ---------- cases ----------

router.get(
  "/cases",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.image_url, c.price,
              COALESCE(uc.qty, 0) AS owned,
              (SELECT count(*)::int FROM case_skins cs WHERE cs.case_id = c.id) AS skin_count
       FROM cases c
       LEFT JOIN user_cases uc ON uc.case_id = c.id AND uc.user_id = $1
       ORDER BY c.id`,
      [req.user.id]
    );
    res.json(rows);
  })
);

// Contents of one case with the drop chance of every skin.
router.get(
  "/cases/:id",
  wrap(async (req, res) => {
    const { rows: caseRows } = await pool.query("SELECT id, name, image_url, price FROM cases WHERE id = $1", [
      Number(req.params.id) || 0,
    ]);
    if (!caseRows[0]) throw new HttpError(404, "Case not found");
    const { rows: skins } = await pool.query(
      `SELECT s.id, s.name, s.image_url, s.min_float, s.max_float,
              r.name AS rarity_name, r.color, r.tier, r.drop_weight
       FROM case_skins cs JOIN skins s ON s.id = cs.skin_id JOIN rarities r ON r.id = s.rarity_id
       WHERE cs.case_id = $1
       ORDER BY r.tier DESC, s.name`,
      [caseRows[0].id]
    );
    // chance = (rarity weight / sum of weights of the rarities PRESENT in this case) / skins of that rarity
    const weightByTier = new Map();
    const countByTier = new Map();
    for (const s of skins) {
      weightByTier.set(s.tier, s.drop_weight);
      countByTier.set(s.tier, (countByTier.get(s.tier) || 0) + 1);
    }
    const totalWeight = [...weightByTier.values()].reduce((a, b) => a + b, 0);
    res.json({
      ...caseRows[0],
      skins: skins.map((s) => ({
        ...s,
        chance: weightByTier.get(s.tier) / totalWeight / countByTier.get(s.tier),
      })),
    });
  })
);

// Open a case. Uses an owned (e.g. admin-granted) case first, otherwise pays the price.
// The whole thing is ONE transaction: payment, draw and item creation succeed or fail together.
router.post(
  "/cases/:id/open",
  wrap(async (req, res) => {
    const caseId = Number(req.params.id) || 0;
    const result = await withTransaction(async (c) => {
      // Lock this player's row: two parallel requests can't both spend the same coins.
      const { rows: u } = await c.query("SELECT balance FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
      const { rows: caseRows } = await c.query("SELECT id, name, price FROM cases WHERE id = $1", [caseId]);
      if (!caseRows[0]) throw new HttpError(404, "Case not found");

      const used = await c.query(
        "UPDATE user_cases SET qty = qty - 1 WHERE user_id = $1 AND case_id = $2 AND qty > 0",
        [req.user.id, caseId]
      );
      let paid = 0;
      if (used.rowCount === 0) {
        paid = caseRows[0].price;
        if (Number(u[0].balance) < paid) throw new HttpError(402, "Not enough coins");
        await c.query("UPDATE users SET balance = balance - $1 WHERE id = $2", [paid, req.user.id]);
        await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'open_case',$2,$3)", [
          req.user.id,
          -paid,
          caseRows[0].name,
        ]);
      }

      const { rows: pool_ } = await c.query(
        `SELECT s.id, s.min_float, s.max_float, r.tier, r.drop_weight
         FROM case_skins cs JOIN skins s ON s.id = cs.skin_id JOIN rarities r ON r.id = s.rarity_id
         WHERE cs.case_id = $1`,
        [caseId]
      );
      // step 1: choose a rarity by its weight, step 2: choose a skin of that rarity uniformly
      const tiers = new Map();
      for (const s of pool_) {
        if (!tiers.has(s.tier)) tiers.set(s.tier, { weight: s.drop_weight, skins: [] });
        tiers.get(s.tier).skins.push(s);
      }
      const tier = pickWeighted([...tiers.values()]);
      const skin = tier.skins[Math.floor(Math.random() * tier.skins.length)];
      const wearFloat = randomFloatBetween(skin.min_float, skin.max_float);

      const { rows: ins } = await c.query(
        "INSERT INTO inventory (user_id, skin_id, wear_float, source) VALUES ($1,$2,$3,'case') RETURNING id",
        [req.user.id, skin.id, wearFloat]
      );
      const { rows: item } = await c.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.id = $1`, [ins[0].id]);
      const { rows: bal } = await c.query("SELECT balance FROM users WHERE id = $1", [req.user.id]);
      return { item: toItem(item[0], await worldMinFloat(c)), paid, free_open: paid === 0, balance: bal[0].balance };
    });
    res.status(201).json(result);
  })
);

// ---------- inventory ----------

router.get(
  "/inventory",
  wrap(async (req, res) => {
    const worldMin = await worldMinFloat(pool);
    const { rows } = await pool.query(
      `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.user_id = $1 ORDER BY i.acquired_at DESC, i.id DESC`,
      [req.user.id]
    );
    res.json(rows.map((r) => toItem(r, worldMin)));
  })
);

// Sell items for their computed price.
router.post(
  "/inventory/sell",
  wrap(async (req, res) => {
    const ids = parseIds((req.body || {}).ids);
    const result = await withTransaction(async (c) => {
      await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
      const { rows } = await c.query(
        `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.id = ANY($1::bigint[]) AND i.user_id = $2 FOR UPDATE OF i`,
        [ids, req.user.id]
      );
      if (rows.length !== ids.length) throw new HttpError(404, "Some items are not in your inventory");
      const worldMin = await worldMinFloat(c);
      const total = rows.reduce((sum, r) => sum + toItem(r, worldMin).price, 0);
      await c.query("DELETE FROM inventory WHERE id = ANY($1::bigint[])", [ids]);
      await c.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [total, req.user.id]);
      await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'sell',$2,$3)", [
        req.user.id,
        total,
        `${ids.length} item(s)`,
      ]);
      const { rows: bal } = await c.query("SELECT balance FROM users WHERE id = $1", [req.user.id]);
      return { sold: ids.length, earned: total, balance: bal[0].balance };
    });
    res.json(result);
  })
);

// ---------- contracts (trade-up) ----------
// 10 items of the same rarity -> 1 item of the next rarity from a case that one of the inputs came from.
// The output float is DETERMINISTIC: take every input's float as a fraction of its own range,
// average the fractions, and place that fraction inside the output skin's range.
// Because the average is known in advance, a player can aim for a specific float (e.g. exactly 0.5).

async function planContract(c, userId, ids, lock) {
  const { rows: inputs } = await c.query(
    `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.id = ANY($1::bigint[]) AND i.user_id = $2 ${lock ? "FOR UPDATE OF i" : ""}`,
    [ids, userId]
  );
  if (inputs.length !== ids.length) throw new HttpError(404, "Some items are not in your inventory");
  const tiers = new Set(inputs.map((r) => r.tier));
  if (tiers.size !== 1) throw new HttpError(400, "All 10 items must have the same rarity");
  const tier = inputs[0].tier;
  const { rows: top } = await c.query("SELECT max(tier) AS t FROM rarities");
  if (tier >= top[0].t) throw new HttpError(400, "The highest rarity can't be traded up");

  const { rows: candidates } = await c.query(
    `WITH avg AS (
       SELECT avg(CASE WHEN s.max_float = s.min_float THEN 0
                       ELSE (i.wear_float - s.min_float) / (s.max_float - s.min_float) END) AS a
       FROM inventory i JOIN skins s ON s.id = i.skin_id
       WHERE i.id = ANY($1::bigint[])
     )
     SELECT o.id AS skin_id, o.name, o.image_url, ro.name AS rarity_name, ro.color, ro.tier, ro.base_price,
            count(*)::int AS weight,
            round(o.min_float + avg.a * (o.max_float - o.min_float), 8) AS result_float
     FROM avg, inventory i
     JOIN case_skins cin  ON cin.skin_id = i.skin_id
     JOIN case_skins cout ON cout.case_id = cin.case_id
     JOIN skins o         ON o.id = cout.skin_id
     JOIN rarities ro     ON ro.id = o.rarity_id AND ro.tier = $2
     WHERE i.id = ANY($1::bigint[])
     GROUP BY o.id, ro.id, avg.a
     ORDER BY o.name`,
    [ids, tier + 1]
  );
  if (candidates.length === 0) throw new HttpError(400, "No possible outcome for these items");
  return { inputs, candidates };
}

router.post(
  "/contracts/preview",
  wrap(async (req, res) => {
    const ids = parseIds((req.body || {}).ids, { exactly: CONTRACT_SIZE });
    const { candidates } = await planContract(pool, req.user.id, ids, false);
    const worldMin = await worldMinFloat(pool);
    const total = candidates.reduce((s, c) => s + c.weight, 0);
    res.json(
      candidates.map((c) => {
        const info = describePrice(c.base_price, c.result_float, worldMin);
        return {
          skin_id: c.skin_id,
          name: c.name,
          image_url: c.image_url,
          rarity: c.rarity_name,
          color: c.color,
          float: c.result_float,
          wear: info.wear,
          special: info.special,
          price: info.price,
          chance: c.weight / total,
        };
      })
    );
  })
);

router.post(
  "/contracts",
  wrap(async (req, res) => {
    const ids = parseIds((req.body || {}).ids, { exactly: CONTRACT_SIZE });
    const result = await withTransaction(async (c) => {
      await c.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
      const { candidates } = await planContract(c, req.user.id, ids, true);
      const won = pickWeighted(candidates);
      await c.query("DELETE FROM inventory WHERE id = ANY($1::bigint[])", [ids]);
      const { rows: ins } = await c.query(
        "INSERT INTO inventory (user_id, skin_id, wear_float, source) VALUES ($1,$2,$3,'contract') RETURNING id",
        [req.user.id, won.skin_id, won.result_float]
      );
      await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'contract',0,$2)", [
        req.user.id,
        `10 items -> ${won.name}`,
      ]);
      const { rows: item } = await c.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.id = $1`, [ins[0].id]);
      return { item: toItem(item[0], await worldMinFloat(c)) };
    });
    res.status(201).json(result);
  })
);

// ---------- misc ----------

router.get(
  "/transactions",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, kind, amount, note, created_at FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 30",
      [req.user.id]
    );
    res.json(rows);
  })
);

router.get(
  "/leaderboard",
  wrap(async (_req, res) => {
    const cleanest = await pool.query(
      `SELECT i.wear_float AS float, s.name, s.image_url, r.color, u.nick
       FROM inventory i JOIN skins s ON s.id = i.skin_id JOIN rarities r ON r.id = s.rarity_id
       JOIN users u ON u.id = i.user_id
       ORDER BY i.wear_float ASC, i.acquired_at ASC LIMIT 10`
    );
    const richest = await pool.query(
      `SELECT u.nick, u.balance, (SELECT count(*)::int FROM inventory i WHERE i.user_id = u.id) AS items
       FROM users u ORDER BY u.balance DESC, u.id LIMIT 10`
    );
    res.json({ cleanest: cleanest.rows, richest: richest.rows });
  })
);

module.exports = { router, toItem, ITEM_COLUMNS, ITEM_JOINS, worldMinFloat };
