const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, 'database.sqlite');
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
          audio_url TEXT NOT NULL
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
            console.log("Database initialized and seeded.");
            resolve();
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
