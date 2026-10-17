const crypto = require("crypto");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 does not catch errors from async handlers by itself; this wrapper forwards them.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Random decimal in [min, max] with exactly 8 digits, using integer maths (no float rounding).
// crypto.randomInt is a secure RNG: the draw happens on the SERVER, the browser can't influence it.
function randomFloatBetween(min, max) {
  const lo = Math.round(Number(min) * 1e8);
  const hi = Math.round(Number(max) * 1e8);
  const value = lo + crypto.randomInt(0, hi - lo + 1);
  return (value / 1e8).toFixed(8);
}

// items: [{ weight: n, ... }] -> one item picked proportionally to its weight
function pickWeighted(items) {
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  let roll = crypto.randomInt(0, total);
  for (const it of items) {
    if (roll < it.weight) return it;
    roll -= it.weight;
  }
  return items[items.length - 1];
}

function parseIds(value, { exactly, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "ids must be a non-empty array");
  const ids = value.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, "ids must be positive integers");
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "duplicate ids");
  if (ids.length > max) throw new HttpError(400, `at most ${max} ids`);
  if (exactly && ids.length !== exactly) throw new HttpError(400, `exactly ${exactly} items are required`);
  return ids;
}

module.exports = { HttpError, wrap, randomFloatBetween, pickWeighted, parseIds };
