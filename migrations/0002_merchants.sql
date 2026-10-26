CREATE TABLE merchants (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  legal_name TEXT,
  email TEXT,
  phone TEXT,
  country_code TEXT,
  api_key_hash TEXT NOT NULL UNIQUE CHECK (length(api_key_hash) = 64),
  recipient TEXT NOT NULL,
  webhook_url TEXT,
  webhook_secret_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK ((webhook_url IS NULL) = (webhook_secret_encrypted IS NULL))
);
CREATE TABLE merchant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  revision INTEGER NOT NULL,
  operator TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_fields TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (merchant_id, revision)
);
CREATE TRIGGER merchant_created AFTER INSERT ON merchants BEGIN
  INSERT INTO merchant_audit (merchant_id, revision, operator, action, changed_fields, created_at)
  VALUES (NEW.id, NEW.revision, NEW.updated_by, 'created', '{}', NEW.updated_at);
END;
CREATE TRIGGER merchant_updated AFTER UPDATE ON merchants BEGIN
  INSERT INTO merchant_audit (merchant_id, revision, operator, action, changed_fields, created_at)
  VALUES (NEW.id, NEW.revision, NEW.updated_by, 'updated', json_object(
    'name', OLD.name IS NOT NEW.name,
    'legal_name', OLD.legal_name IS NOT NEW.legal_name,
    'email', OLD.email IS NOT NEW.email,
    'phone', OLD.phone IS NOT NEW.phone,
    'country_code', OLD.country_code IS NOT NEW.country_code,
    'api_key_hash', OLD.api_key_hash IS NOT NEW.api_key_hash,
    'recipient', OLD.recipient IS NOT NEW.recipient,
    'webhook_url', OLD.webhook_url IS NOT NEW.webhook_url,
    'webhook_secret_encrypted', OLD.webhook_secret_encrypted IS NOT NEW.webhook_secret_encrypted,
    'status', OLD.status IS NOT NEW.status
  ), NEW.updated_at);
END;
