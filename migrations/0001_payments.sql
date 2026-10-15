CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  merchant_reference TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  usd_cents INTEGER NOT NULL CHECK (usd_cents > 0),
  lamports TEXT NOT NULL,
  usd_price TEXT NOT NULL,
  price_block_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  signature TEXT UNIQUE,
  payer TEXT,
  settled_at INTEGER,
  UNIQUE (merchant_id, idempotency_key)
);
CREATE TABLE attempts (
  payment_id TEXT NOT NULL REFERENCES payments(id),
  signature TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'rejected', 'verified')),
  reason TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (payment_id, signature)
);
CREATE INDEX attempts_due ON attempts(state, next_attempt_at);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  merchant_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT
);
CREATE INDEX events_due ON events(delivered_at, next_attempt_at);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
