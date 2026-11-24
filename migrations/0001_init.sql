CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE no_school_days (
  date TEXT PRIMARY KEY,
  note TEXT
);

-- One row per checkout / cash payment
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,              -- 'card' | 'cash' | 'demo'
  status TEXT NOT NULL,              -- 'pending' | 'paid'
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT UNIQUE,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  date TEXT NOT NULL,
  swag INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, date)
);

-- The source of truth: a row here means this person is paid up to wear jeans that day
CREATE TABLE jean_days (
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  swag INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX jean_days_date ON jean_days(date);
