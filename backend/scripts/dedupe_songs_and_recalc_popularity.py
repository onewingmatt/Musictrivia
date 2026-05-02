#!/usr/bin/env python3
"""
Merge duplicate songs by normalized (title, artist), fold their source rows and
answers onto a single canonical song, then recompute popularity from merged
source rows.

This is meant to clean up databases that were populated by multiple imports or
partial reimports.

Behavior:
- Duplicates are grouped by case-insensitive trimmed title + artist.
- One canonical row is kept per group.
- song_sources rows are merged into the canonical row.
- user_answers rows are reassigned to the canonical row.
- The duplicate song rows are deleted.
- Popularity is recomputed from merged song_sources using the strongest
  source_popularity value for each song.

Usage:
  python dedupe_songs_and_recalc_popularity.py --db /path/to/database.sqlite
  python dedupe_songs_and_recalc_popularity.py --db /path/to/database.sqlite --dry-run
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
from collections import defaultdict
from pathlib import Path


def norm(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def has_column(cur, table: str, column: str) -> bool:
    return any(row[1] == column for row in cur.execute(f"PRAGMA table_info({table})").fetchall())


def source_rows_for_song(cur, song_id: int):
    return cur.execute(
        "SELECT source, source_popularity, chart_entries FROM song_sources WHERE song_id = ?",
        (song_id,),
    ).fetchall()


def merge_source_rows(cur, canonical_id: int, duplicate_id: int) -> None:
    rows = source_rows_for_song(cur, duplicate_id)
    for source, source_popularity, chart_entries in rows:
        cur.execute(
            """
            INSERT INTO song_sources (song_id, source, source_popularity, chart_entries)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(song_id, source) DO UPDATE SET
              source_popularity = MAX(song_sources.source_popularity, excluded.source_popularity),
              chart_entries = song_sources.chart_entries + excluded.chart_entries
            """,
            (canonical_id, source, int(source_popularity or 0), int(chart_entries or 1)),
        )


def recompute_popularity(cur, song_id: int) -> int:
    rows = source_rows_for_song(cur, song_id)
    if not rows:
        row = cur.execute("SELECT popularity FROM songs WHERE id = ?", (song_id,)).fetchone()
        return int(row[0] or 0) if row else 0
    return max(int(r[1] or 0) for r in rows)


def pick_canonical(rows):
    """Prefer the row with the best existing metadata, then lowest id for stability."""
    def score(row):
        song_id, title, artist, genre, decade, popularity, audio_url, youtube_id = row
        return (
            0 if (genre and genre != 'Unknown') else 1,
            0 if audio_url else 1,
            0 if youtube_id else 1,
            -(int(popularity or 0)),
            song_id,
        )

    return min(rows, key=score)


def merge_song_metadata(cur, canonical, duplicate, has_peak, has_weeks):
    c_id, c_title, c_artist, c_genre, c_decade, c_pop, c_audio, c_yt = canonical
    d_id, d_title, d_artist, d_genre, d_decade, d_pop, d_audio, d_yt = duplicate

    genre = c_genre
    if (not genre) or genre == 'Unknown':
        genre = d_genre if d_genre else genre

    decade = c_decade if c_decade is not None else d_decade
    audio_url = c_audio or d_audio or ''
    youtube_id = c_yt or d_yt or ''
    popularity = max(int(c_pop or 0), int(d_pop or 0))

    fields = ["genre = ?", "decade = ?", "popularity = ?", "audio_url = ?", "youtube_id = ?"]
    params = [genre or 'Unknown', decade or 2000, popularity, audio_url, youtube_id]

    if has_peak:
        c_peak = cur.execute("SELECT peak_position FROM songs WHERE id = ?", (c_id,)).fetchone()[0]
        d_peak = cur.execute("SELECT peak_position FROM songs WHERE id = ?", (d_id,)).fetchone()[0]
        peak = None
        peaks = [p for p in [c_peak, d_peak] if p is not None]
        if peaks:
            peak = min(int(p) for p in peaks)
        fields.append("peak_position = ?")
        params.append(peak)

    if has_weeks:
        c_weeks = cur.execute("SELECT weeks_on_chart FROM songs WHERE id = ?", (c_id,)).fetchone()[0]
        d_weeks = cur.execute("SELECT weeks_on_chart FROM songs WHERE id = ?", (d_id,)).fetchone()[0]
        weeks = None
        weeks_vals = [w for w in [c_weeks, d_weeks] if w is not None]
        if weeks_vals:
            weeks = max(int(w) for w in weeks_vals)
        fields.append("weeks_on_chart = ?")
        params.append(weeks)

    params.append(c_id)
    cur.execute(f"UPDATE songs SET {', '.join(fields)} WHERE id = ?", params)


def dedupe_and_recalc(db_path: str, dry_run: bool = False):
    conn = sqlite3.connect(os.path.abspath(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    has_peak = has_column(cur, 'songs', 'peak_position')
    has_weeks = has_column(cur, 'songs', 'weeks_on_chart')

    rows = cur.execute("SELECT id, title, artist, genre, decade, popularity, audio_url, youtube_id FROM songs ORDER BY id").fetchall()

    groups = defaultdict(list)
    for row in rows:
        groups[(norm(row['title']), norm(row['artist']))].append(row)

    duplicate_groups = {k: v for k, v in groups.items() if len(v) > 1}
    duplicate_count = sum(len(v) - 1 for v in duplicate_groups.values())

    if dry_run:
        print(f"duplicate_groups={len(duplicate_groups)} duplicate_rows={duplicate_count}")
        for (title_key, artist_key), items in list(duplicate_groups.items())[:10]:
            print(f"group={title_key} || {artist_key} ids={[r['id'] for r in items]}")
        return

    songs_deleted = 0
    source_rows_moved = 0
    answers_moved = 0
    popularity_updated = 0

    conn.execute('BEGIN')
    try:
        for _, items in duplicate_groups.items():
            canonical = pick_canonical([tuple(item) for item in items])
            canonical_id = canonical[0]

            # Reassign dependent rows and merge source rows into the canonical song.
            for duplicate in items:
                duplicate_id = duplicate['id']
                if duplicate_id == canonical_id:
                    continue

                merge_song_metadata(cur, canonical, duplicate, has_peak, has_weeks)
                merge_source_rows(cur, canonical_id, duplicate_id)

                moved_answers = cur.execute(
                    "UPDATE user_answers SET song_id = ? WHERE song_id = ?",
                    (canonical_id, duplicate_id),
                ).rowcount
                answers_moved += max(0, moved_answers)

                source_rows_moved += cur.execute(
                    "SELECT COUNT(*) FROM song_sources WHERE song_id = ?",
                    (canonical_id,),
                ).fetchone()[0]

                cur.execute("DELETE FROM songs WHERE id = ?", (duplicate_id,))
                songs_deleted += 1

            # Recompute popularity using merged source rows.
            new_pop = recompute_popularity(cur, canonical_id)
            cur.execute("UPDATE songs SET popularity = ? WHERE id = ?", (new_pop, canonical_id))
            popularity_updated += 1

        # Recompute popularity for all other songs too, in case source rows changed elsewhere.
        all_song_ids = [row['id'] for row in cur.execute("SELECT id FROM songs").fetchall()]
        for song_id in all_song_ids:
            new_pop = recompute_popularity(cur, song_id)
            cur.execute("UPDATE songs SET popularity = ? WHERE id = ?", (new_pop, song_id))
            popularity_updated += 1

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print(
        f"duplicate_groups={len(duplicate_groups)} songs_deleted={songs_deleted} "
        f"answers_moved={answers_moved} source_rows_moved={source_rows_moved} "
        f"popularity_updated={popularity_updated}"
    )


def main():
    parser = argparse.ArgumentParser(description='Deduplicate songs and recompute popularity from merged chart sources')
    parser.add_argument('--db', required=True, help='Path to SQLite database')
    parser.add_argument('--dry-run', action='store_true', help='Print duplicate groups without changing anything')
    args = parser.parse_args()
    dedupe_and_recalc(args.db, dry_run=args.dry_run)


if __name__ == '__main__':
    main()
