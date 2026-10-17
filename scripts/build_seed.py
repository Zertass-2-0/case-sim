"""One-off dev script: builds backend/data/seed.json from the open ByMykel/CSGO-API dataset.

Usage:
    python scripts/build_seed.py <collections.json> <skins.json>

The files come from
https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/{collections,skins}.json
The generated seed.json is committed, so `docker compose up` needs no internet access for data.
Images are NOT downloaded: we only store the URLs (hot-linked from the Steam CDN).
"""
import json
import sys
from pathlib import Path

CASE_COLLECTIONS = {
    "collection-set-community-3": 80,   # Huntsman Weapon Case
    "collection-set-community-7": 80,   # Chroma 2 Case
    "collection-set-community-10": 100,  # Revolver Case
    "collection-set-community-22": 100,  # Prisma Case
}

# tier 1 = lowest. drop_weight is "per 10000" like in the real game (renormalised: no knives here).
RARITIES = [
    {"code": "rarity_rare_weapon", "name": "Mil-Spec", "color": "#4b69ff", "tier": 1, "drop_weight": 7992, "base_price": 20},
    {"code": "rarity_mythical_weapon", "name": "Restricted", "color": "#8847ff", "tier": 2, "drop_weight": 1598, "base_price": 100},
    {"code": "rarity_legendary_weapon", "name": "Classified", "color": "#d32ce6", "tier": 3, "drop_weight": 320, "base_price": 500},
    {"code": "rarity_ancient_weapon", "name": "Covert", "color": "#eb4b4b", "tier": 4, "drop_weight": 64, "base_price": 3000},
]


def main(collections_path, skins_path):
    collections = {c["id"]: c for c in json.load(open(collections_path, encoding="utf-8"))}
    float_ranges = {s["id"]: (s["min_float"], s["max_float"]) for s in json.load(open(skins_path, encoding="utf-8"))}
    known = {r["code"] for r in RARITIES}

    skins, cases = {}, []
    for cid, price in CASE_COLLECTIONS.items():
        col = collections[cid]
        crate = col["crates"][0]
        in_case = []
        for item in col["contains"]:
            if item["rarity"]["id"] not in known:
                continue
            lo, hi = float_ranges.get(item["id"], (0, 1))
            skins.setdefault(item["id"], {
                "id": item["id"],
                "name": item["name"],
                "rarity": item["rarity"]["id"],
                "image": item["image"],
                "min_float": lo,
                "max_float": hi,
            })
            in_case.append(item["id"])
        cases.append({"name": crate["name"], "image": crate["image"], "price": price, "skins": in_case})

    out = {"rarities": RARITIES, "cases": cases, "skins": list(skins.values())}
    target = Path(__file__).resolve().parent.parent / "backend" / "data" / "seed.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {target}: {len(cases)} cases, {len(skins)} skins")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
