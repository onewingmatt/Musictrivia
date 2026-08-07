const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'database.sqlite');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new sqlite3.Database(dbPath);

const initDb = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Users table
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Songs table
      db.run(`
        CREATE TABLE IF NOT EXISTS songs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          artist TEXT NOT NULL,
          genre TEXT NOT NULL,
          decade INTEGER NOT NULL,
          popularity INTEGER DEFAULT 50,
          audio_url TEXT NOT NULL,
          youtube_id TEXT,
          peak_position INTEGER,
          weeks_on_chart INTEGER,
          weeks_at_1 INTEGER DEFAULT 0,
          us_popularity INTEGER DEFAULT 0,
          ca_popularity INTEGER DEFAULT 0,
          hidden INTEGER DEFAULT 0
        )
      `);

      // Source mappings used by quiz filters
      db.run(`
        CREATE TABLE IF NOT EXISTS song_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          song_id INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_popularity INTEGER DEFAULT 50,
          chart_entries INTEGER DEFAULT 1,
          UNIQUE(song_id, source)
        )
      `);

      // User Answers table
      db.run(`
        CREATE TABLE IF NOT EXISTS user_answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          song_id INTEGER NOT NULL,
          guessed_title TEXT,
          guessed_artist TEXT,
          is_title_correct BOOLEAN,
          is_artist_correct BOOLEAN,
          points_awarded INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (song_id) REFERENCES songs (id)
        )
      `);

      // Saved quiz presets
      db.run(`
        CREATE TABLE IF NOT EXISTS quiz_configs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          config_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // Check if songs need seeding
      db.get("SELECT COUNT(*) as count FROM songs", (err, row) => {
        if (err) {
          reject(err);
        } else if (row.count === 0) {
          const stmt = db.prepare("INSERT INTO songs (title, artist, genre, decade, popularity, audio_url) VALUES (?, ?, ?, ?, ?, ?)");
          const mockSongs = [
            ["Never Gonna Give You Up", "Rick Astley", "Pop", 1980, 100, "dQw4w9WgXcQ"],
            ["Bohemian Rhapsody", "Queen", "Rock", 1970, 95, "fJ9rUzIMcZQ"],
            ["Billie Jean", "Michael Jackson", "Pop", 1980, 98, "Zi_XLOBDo_Y"],
            ["Smells Like Teen Spirit", "Nirvana", "Rock", 1990, 90, "hTWKbfoikeg"],
            ["Lose Yourself", "Eminem", "Hip Hop", 2000, 85, "_Yhyp-_hX2s"],
            ["Hey Jude", "The Beatles", "Rock", 1960, 99, "A_MjCqQoLLA"],
            ["Take On Me", "a-ha", "Pop", 1980, 80, "djV11Xbc914"],
            ["Creep", "Radiohead", "Rock", 1990, 85, "XFkzRNyygfk"],
            ["Blinding Lights", "The Weeknd", "Pop", 2020, 95, "4NRXx6U8ABQ"],
            ["Wonderwall", "Oasis", "Rock", 1990, 90, "6hzrDeceEKc"]
          ];

          mockSongs.forEach(song => {
            stmt.run(song);
          });
          stmt.finalize(() => {
            const sourceStmt = db.prepare("INSERT OR IGNORE INTO song_sources (song_id, source, source_popularity, chart_entries) VALUES (?, ?, ?, ?)");
            mockSongs.forEach((song, idx) => {
              sourceStmt.run(idx + 1, 'billboard-us', song[4], 1);
            });
            sourceStmt.finalize(() => {
              console.log("Database initialized and seeded.");
              resolve();
            });
          });
        } else {
          console.log("Database initialized.");
          resolve();
        }
      });
    });
  });
};

module.exports = { db, initDb };
