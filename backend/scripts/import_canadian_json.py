#!/usr/bin/env python3
"""
Import Canadian chart rows exported by export_canadian_json.py.

This is intended for the VPS. It merges Canadian chart data into the existing
MusicTrivia SQLite DB without touching unrelated rows.
"""

import argparse
import json
import os
import sqlite3
from pathlib import Path


def ensure_schema(conn):
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS song_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          song_id INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_popularity INTEGER DEFAULT 50,
          chart_entries INTEGER DEFAULT 1,
          UNIQUE(song_id, source)
        )
        """
    )
    conn.commit()


def upsert_song(conn, song):
    cur = conn.cursor()
    row = cur.execute(
        "SELECT id FROM songs WHERE title = ? AND artist = ? LIMIT 1",
        (song["title"], song["artist"]),
    ).fetchone()
    if row:
        song_id = row[0]
        cur.execute(
            """
            UPDATE songs
               SET genre = COALESCE(NULLIF(?, ''), genre),
                   decade = COALESCE(?, decade),
                   popularity = MAX(COALESCE(popularity, 0), COALESCE(?, 0)),
                   audio_url = COALESCE(NULLIF(?, ''), audio_url),
                   youtube_id = COALESCE(NULLIF(?, ''), youtube_id)
             WHERE id = ?
            """,
            (
                song.get("genre"),
                song.get("decade"),
                song.get("popularity"),
                song.get("audio_url"),
                song.get("youtube_id"),
                song_id,
            ),
        )
        return song_id, False

    cur.execute(
        """
        INSERT INTO songs (title, artist, genre, decade, popularity, audio_url, youtube_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            song["title"],
            song["artist"],
            song.get("genre") or "Unknown",
            song.get("decade") or 2000,
            song.get("popularity") or 0,
            song.get("audio_url") or "",
            song.get("youtube_id") or "",
        ),
    )
    return cur.lastrowid, True


def import_payload(conn, payload):
    ensure_schema(conn)
    cur = conn.cursor()
    song_lookup = {}
    inserted = updated = source_rows = 0

    for song in payload["songs"]:
        song_id, created = upsert_song(conn, song)
        song_lookup[(song["title"], song["artist"])] = song_id
        inserted += 1 if created else 0
        updated += 0 if created else 1

    for src in payload["song_sources"]:
        if "song_id" in src:
            # Backward-compatible format from older exports.
            song_id = None
            for song in payload["songs"]:
                if song["id"] == src["song_id"]:
                    song_id = song_lookup[(song["title"], song["artist"])]
                    break
            if song_id is None:
                continue
        else:
            song_id = song_lookup[(src["title"], src["artist"])]
        cur.execute(
            """
            INSERT INTO song_sources (song_id, source, source_popularity, chart_entries)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(song_id, source) DO UPDATE SET
              source_popularity = MAX(song_sources.source_popularity, excluded.source_popularity),
              chart_entries = song_sources.chart_entries + excluded.chart_entries
            """,
            (song_id, src["source"], src.get("source_popularity") or 0, src.get("chart_entries") or 1),
        )
        source_rows += 1

    conn.commit()
    return inserted, updated, source_rows


def main():
    parser = argparse.ArgumentParser(description="Import Canadian chart JSON into MusicTrivia SQLite")
    parser.add_argument("--db", required=True, help="Path to target SQLite DB")
    parser.add_argument("--infile", required=True, help="Input JSON path")
    args = parser.parse_args()

    payload = json.loads(Path(args.infile).read_text(encoding="utf-8"))
    conn = sqlite3.connect(os.path.abspath(args.db))
    try:
        inserted, updated, source_rows = import_payload(conn, payload)
        print(f"imported inserted={inserted} updated={updated} source_rows={source_rows}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
