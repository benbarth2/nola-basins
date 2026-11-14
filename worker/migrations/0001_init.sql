CREATE TABLE IF NOT EXISTS submissions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  created   TEXT NOT NULL,
  reviewed  TEXT,
  status    TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  address   TEXT,
  cleaned   TEXT NOT NULL,                      -- YYYY-MM-DD
  label     TEXT,                               -- cleanup name shown on the map (set on approval)
  name      TEXT,                               -- submitter, private
  email     TEXT,                               -- submitter, private
  note      TEXT,
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS submissions_ip_created ON submissions(ip, created);

CREATE TABLE IF NOT EXISTS photos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_id  INTEGER NOT NULL REFERENCES submissions(id),
  type    TEXT NOT NULL,
  data    TEXT NOT NULL                         -- base64
);
CREATE INDEX IF NOT EXISTS photos_sub ON photos(sub_id);
