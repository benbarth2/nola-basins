CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  date       TEXT NOT NULL,          -- YYYY-MM-DD
  start_time TEXT,                   -- HH:MM (24h)
  end_time   TEXT,
  note       TEXT,
  locations  TEXT NOT NULL DEFAULT '[]',  -- JSON: [{name, place, address, lat, lon}]
  created    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);

CREATE TABLE IF NOT EXISTS requests (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  created   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'new',   -- new | handled
  address   TEXT NOT NULL,                 -- where to meet
  lat       REAL,
  lon       REAL,
  name      TEXT,
  email     TEXT,
  phone     TEXT,
  helpers   TEXT,                          -- yes | no | not-sure
  helpers_count INTEGER,
  note      TEXT,
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);

INSERT INTO events (title, date, start_time, end_time, note, locations, created) VALUES (
  'District B Neighborhood Clean Up Day', '2026-12-12', '09:00', '12:00',
  'Meet at whichever spot is closest to you.',
  '[{"name":"Broadmoor","place":"Rosa F. Keller Library & Community Center","address":"4300 S Broad St","lat":29.948798,"lon":-90.103544},{"name":"Central City","place":"Barbara Lacen-Keller Park","address":"1801 S Robertson St","lat":29.94375,"lon":-90.08656}]',
  datetime('now')
);
