-- Schema is idempotent (IF NOT EXISTS) so it is safe to run on every start.

CREATE TABLE IF NOT EXISTS rarities (
    id           SERIAL PRIMARY KEY,
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    color        TEXT    NOT NULL,
    tier         INTEGER NOT NULL UNIQUE,          -- 1 = lowest; contracts go tier -> tier+1
    drop_weight  INTEGER NOT NULL CHECK (drop_weight > 0),
    base_price   INTEGER NOT NULL CHECK (base_price > 0)
);

CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    nick           TEXT    NOT NULL,
    password_hash  TEXT    NOT NULL,               -- bcrypt hash, never the password itself
    balance        BIGINT  NOT NULL DEFAULT 0 CHECK (balance >= 0),
    is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- nicks are case-insensitive unique ("Bob" and "bob" are the same player)
CREATE UNIQUE INDEX IF NOT EXISTS users_nick_lower_idx ON users (lower(nick));

CREATE TABLE IF NOT EXISTS skins (
    id          TEXT PRIMARY KEY,                  -- id from the open dataset, e.g. skin-bc677a3996cc
    name        TEXT NOT NULL,
    rarity_id   INTEGER NOT NULL REFERENCES rarities(id),
    image_url   TEXT NOT NULL,                     -- hot-linked, we do not store images
    min_float   NUMERIC(9,8) NOT NULL CHECK (min_float BETWEEN 0 AND 1),
    max_float   NUMERIC(9,8) NOT NULL CHECK (max_float BETWEEN 0 AND 1),
    CHECK (min_float <= max_float)
);

CREATE TABLE IF NOT EXISTS cases (
    id         SERIAL PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE,
    image_url  TEXT    NOT NULL,
    price      INTEGER NOT NULL CHECK (price > 0)
);

-- many-to-many: a case holds many skins, a skin can sit in several cases
CREATE TABLE IF NOT EXISTS case_skins (
    case_id  INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    skin_id  TEXT    NOT NULL REFERENCES skins(id) ON DELETE CASCADE,
    PRIMARY KEY (case_id, skin_id)
);

-- unopened cases a player owns (e.g. granted by an admin); opening uses these first
CREATE TABLE IF NOT EXISTS user_cases (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    case_id  INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    qty      INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
    PRIMARY KEY (user_id, case_id)
);

-- every item is a unique instance with its own float. NUMERIC (not FLOAT): exact decimal,
-- so "exactly 0.5" is a reliable comparison.
CREATE TABLE IF NOT EXISTS inventory (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skin_id      TEXT    NOT NULL REFERENCES skins(id),
    wear_float   NUMERIC(9,8) NOT NULL CHECK (wear_float BETWEEN 0 AND 1),
    source       TEXT    NOT NULL CHECK (source IN ('case', 'contract', 'admin')),
    acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_user_idx ON inventory (user_id);
CREATE INDEX IF NOT EXISTS inventory_float_idx ON inventory (wear_float);

-- append-only ledger of every balance change
CREATE TABLE IF NOT EXISTS transactions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,                  -- signup, open_case, sell, contract, admin_money
    amount      BIGINT  NOT NULL,                  -- signed change of balance
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (user_id, created_at DESC);
