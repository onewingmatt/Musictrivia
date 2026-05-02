#!/usr/bin/env python3
"""
Export Canadian chart rows from a local MusicTrivia SQLite database.

This is meant to run on the machine that already has the populated local DB.
It exports only the Canadian-related rows to a JSON file that can be copied to
and imported on the VPS.
"""

import argparse
import json
import os
import sqlite3
from pathlib import Path

DEFAULT_SOURCES = [
    "billboard-canada",
    "wikipedia-canada-number-ones",
]


def export_canadian(db_path, sources):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    song_rows = cur.execute(
        f"""
        SELECT DISTINCT s.id, s.title, s.artist, s.genre, s.decade, s.popularity, s.audio_url, s.youtube_id
          FROM songs s
          JOIN song_sources ss ON ss.song_id = s.id
         WHERE ss.source IN ({','.join('?' for _ in sources)})
         ORDER BY s.artist, s.title
        """,
        sources,
    ).fetchall()

    source_rows = []
    if song_rows:
        titles_artists = [(row[1], row[2]) for row in song_rows]
        placeholders = ' OR '.join('(s.title = ? AND s.artist = ?)' for _ in titles_artists)
        source_rows = cur.execute(
            f"""
            SELECT s.title, s.artist, ss.source, ss.source_popularity, ss.chart_entries
              FROM song_sources ss
              JOIN songs s ON s.id = ss.song_id
             WHERE ({placeholders})
               AND ss.source IN ({','.join('?' for _ in sources)})
             ORDER BY s.artist, s.title, ss.source
            """,
            [item for pair in titles_artists for item in pair] + sources,
        ).fetchall()

    conn.close()

    songs = [
        {
            "id": row[0],
            "title": row[1],
            "artist": row[2],
            "genre": row[3],
            "decade": row[4],
            "popularity": row[5],
            "audio_url": row[6],
            "youtube_id": row[7],
        }
        for row in song_rows
    ]
    sources_out = [
        {
            "title": row[0],
            "artist": row[1],
            "source": row[2],
            "source_popularity": row[3],
            "chart_entries": row[4],
        }
        for row in source_rows
    ]
    return {"sources": sources, "songs": songs, "song_sources": sources_out}


def main():
    parser = argparse.ArgumentParser(description="Export Canadian chart rows from MusicTrivia SQLite")
    parser.add_argument("--db", required=True, help="Path to local SQLite DB")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--sources", nargs="*", default=DEFAULT_SOURCES, help="Source names to export")
    args = parser.parse_args()

    payload = export_canadian(os.path.abspath(args.db), args.sources)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {len(payload['songs'])} songs and {len(payload['song_sources'])} source rows to {out_path}")


if __name__ == "__main__":
    main()
