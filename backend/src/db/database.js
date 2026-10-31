const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'game.sqlite'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL,
    lock_id INTEGER NOT NULL,
    solved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, lock_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    wrong_answers INTEGER NOT NULL DEFAULT 0,
    hints_used INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
// Upgrade older databases: add the columns used by difficulty levels and streak bonuses.
const runColumns = db.prepare('PRAGMA table_info(runs)').all().map((col) => col.name);
function addRunColumn(name, definition) {
  if (!runColumns.includes(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
}
addRunColumn('difficulty', "TEXT NOT NULL DEFAULT 'normal'");
addRunColumn('streak', 'INTEGER NOT NULL DEFAULT 0');
addRunColumn('bonus', 'INTEGER NOT NULL DEFAULT 0');
module.exports = db;
