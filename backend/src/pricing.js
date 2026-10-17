// Price of one item = base price of its rarity * wear multiplier * special-float multiplier.
//
// Special floats (the biggest one applies, they don't stack):
//   exactly 0.5          x25  (practically only reachable through a contract: its float is the
//                              deterministic average of the 10 inputs, so you can aim for it)
//   float < 0.001        x15
//   cleanest item in the whole game (lowest float of every inventory, and below 0.01)   x50

const WEARS = [
  { name: "Factory New", max: 0.07, multiplier: 1.6 },
  { name: "Minimal Wear", max: 0.15, multiplier: 1.2 },
  { name: "Field-Tested", max: 0.38, multiplier: 1.0 },
  { name: "Well-Worn", max: 0.45, multiplier: 0.8 },
  { name: "Battle-Scarred", max: Infinity, multiplier: 0.6 },
];

function wearOf(floatStr) {
  const f = Number(floatStr);
  return WEARS.find((w) => f < w.max) || WEARS[WEARS.length - 1];
}

// worldMinFloat: the lowest wear_float currently stored in ANY inventory (string or null)
function describePrice(basePrice, floatStr, worldMinFloat) {
  const f = Number(floatStr);
  const wear = wearOf(floatStr);

  let special = null;
  let specialMultiplier = 1;
  const candidates = [];
  if (f === 0.5) candidates.push({ label: "Perfect 0.5", multiplier: 25 });
  if (f < 0.001) candidates.push({ label: "Ultra-low float", multiplier: 15 });
  if (worldMinFloat !== null && f === Number(worldMinFloat) && f < 0.01)
    candidates.push({ label: "Cleanest in the world", multiplier: 50 });
  for (const c of candidates) {
    if (c.multiplier > specialMultiplier) {
      special = c.label;
      specialMultiplier = c.multiplier;
    }
  }

  return {
    wear: wear.name,
    special,
    price: Math.max(1, Math.round(basePrice * wear.multiplier * specialMultiplier)),
  };
}

module.exports = { describePrice, wearOf };
