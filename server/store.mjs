import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, subject TEXT NOT NULL, request_id TEXT NOT NULL,
        data TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(subject, request_id));`);
  }
  close() { this.db.close(); }
  session(id) { const row = this.db.prepare('SELECT data FROM sessions WHERE id=? AND expires>?').get(id, Date.now()); return row && JSON.parse(row.data); }
  saveSession(id, data, expires) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(id, JSON.stringify(data), expires); }
  deleteSession(id) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  cleanup() { this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); }
  get(id) { const row = this.db.prepare('SELECT data FROM launches WHERE id=?').get(id); return row && JSON.parse(row.data); }
  find(subject, requestID) { const row = this.db.prepare('SELECT data FROM launches WHERE subject=? AND request_id=?').get(subject, requestID); return row && JSON.parse(row.data); }
  list(subject) { return this.db.prepare('SELECT data FROM launches WHERE subject=? ORDER BY created DESC').all(subject).map(row => JSON.parse(row.data)); }
  insert(launch) { this.db.prepare('INSERT INTO launches VALUES (?,?,?,?,?)').run(launch.id, launch.subject, launch.requestID, JSON.stringify(launch), Date.now()); }
  save(launch) { this.db.prepare('UPDATE launches SET data=? WHERE id=?').run(JSON.stringify(launch), launch.id); }
}
