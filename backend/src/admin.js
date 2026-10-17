const express = require("express");
const { pool, withTransaction } = require("./db");
const { HttpError, wrap, randomFloatBetween } = require("./util");

const router = express.Router();

async function findUser(client, nick) {
  if (typeof nick !== "string") throw new HttpError(400, "nick is required");
  const { rows } = await client.query("SELECT id, nick FROM users WHERE lower(nick) = lower($1) FOR UPDATE", [nick]);
  if (!rows[0]) throw new HttpError(404, `No player with nick "${nick}"`);
  return rows[0];
}

router.get(
  "/users",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.nick, u.balance, u.is_admin,
              (SELECT count(*)::int FROM inventory i WHERE i.user_id = u.id) AS items,
              (SELECT COALESCE(sum(qty), 0)::int FROM user_cases uc WHERE uc.user_id = u.id) AS cases
       FROM users u ORDER BY u.id`
    );
    res.json(rows);
  })
);

router.get(
  "/skins",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.min_float, s.max_float, r.name AS rarity
       FROM skins s JOIN rarities r ON r.id = s.rarity_id ORDER BY r.tier DESC, s.name`
    );
    res.json(rows);
  })
);

// Give (or take, with a negative number) coins.
router.post(
  "/money",
  wrap(async (req, res) => {
    const amount = Number((req.body || {}).amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1e9) throw new HttpError(400, "amount must be a non-zero integer");
    const out = await withTransaction(async (c) => {
      const user = await findUser(c, req.body.nick);
      // CHECK (balance >= 0) in the schema rejects a withdrawal bigger than the balance
      const { rows } = await c.query("UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance", [amount, user.id]);
      await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'admin_money',$2,$3)", [
        user.id,
        amount,
        `by admin ${req.user.nick}`,
      ]);
      return { nick: user.nick, balance: rows[0].balance };
    });
    res.json(out);
  })
);

// Give a skin; the float is random inside the skin's range unless the admin sets it explicitly.
router.post(
  "/skin",
  wrap(async (req, res) => {
    const { nick, skinId, float } = req.body || {};
    const out = await withTransaction(async (c) => {
      const user = await findUser(c, nick);
      const { rows: skins } = await c.query("SELECT id, name, min_float, max_float FROM skins WHERE id = $1", [skinId]);
      if (!skins[0]) throw new HttpError(404, "Unknown skin");
      let wearFloat;
      if (float === undefined || float === null || float === "") {
        wearFloat = randomFloatBetween(skins[0].min_float, skins[0].max_float);
      } else {
        const f = Number(float);
        if (!(f >= Number(skins[0].min_float) && f <= Number(skins[0].max_float)))
          throw new HttpError(400, `float must be between ${skins[0].min_float} and ${skins[0].max_float} for this skin`);
        wearFloat = f.toFixed(8);
      }
      const { rows } = await c.query(
        "INSERT INTO inventory (user_id, skin_id, wear_float, source) VALUES ($1,$2,$3,'admin') RETURNING id, wear_float",
        [user.id, skins[0].id, wearFloat]
      );
      return { nick: user.nick, skin: skins[0].name, float: rows[0].wear_float };
    });
    res.status(201).json(out);
  })
);

// Give unopened cases.
router.post(
  "/case",
  wrap(async (req, res) => {
    const { nick, caseId } = req.body || {};
    const qty = Number((req.body || {}).qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new HttpError(400, "qty must be 1-1000");
    const out = await withTransaction(async (c) => {
      const user = await findUser(c, nick);
      const { rows: cases } = await c.query("SELECT id, name FROM cases WHERE id = $1", [Number(caseId) || 0]);
      if (!cases[0]) throw new HttpError(404, "Unknown case");
      const { rows } = await c.query(
        `INSERT INTO user_cases (user_id, case_id, qty) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, case_id) DO UPDATE SET qty = user_cases.qty + EXCLUDED.qty
         RETURNING qty`,
        [user.id, cases[0].id, qty]
      );
      return { nick: user.nick, case: cases[0].name, owned: rows[0].qty };
    });
    res.status(201).json(out);
  })
);

module.exports = { router };
