#!/usr/bin/env python3
"""
Incremental updater for Canadian Hot 100 data.

This is meant to be the ongoing updater after the yearly Wikipedia bootstrap.
It only imports new weekly Billboard Canadian Hot 100 charts that have not
already been processed, so it stays fast and doesn't crawl the whole archive.

Usage:
  python import_canadian_live.py
  python import_canadian_live.py --backfill-weeks 12
  python import_canadian_live.py --db /data/database.sqlite --backfill-weeks 24
"""

import argparse
import math
import os
import sqlite3
from datetime import date, datetime, timedelta

import billboard

DEFAULT_CHART_NAME = "canadian-hot-100"
DEFAULT_SOURCE_NAME = "billboard-canada"
DEFAULT_START_DATE = date(2007, 6, 16)


def parse_date(text: str) -> date:
    return datetime.strptime(text, "%Y-%m-%d").date()


def calc_popularity(peak_position, weeks_on_chart):
    try:
        peak_position = int(peak_position)
    except Exception:
        peak_position = 100
    try:
        weeks_on_chart = int(weeks_on_chart)
    except Exception:
        weeks_on_chart = 1

    peak_comp = 55 * ((100 - peak_position) / 100) ** 1.5
    number_one_bonus = 15 if peak_position == 1 else 0
    weeks_comp = 30 * (1 - math.exp(-weeks_on_chart / 25))
    return min(100, max(0, int(peak_comp + number_one_bonus + weeks_comp)))


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
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS chart_import_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          chart_name TEXT NOT NULL,
          issue_date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source, issue_date)
        )
        """
    )
    conn.commit()


def upsert_song(conn, song):
    cur = conn.cursor()
    row = cur.execute(
        "SELECT id, popularity, decade FROM songs WHERE title = ? AND artist = ? LIMIT 1",
        (song["title"], song["artist"]),
    ).fetchone()

    if row:
        song_id, existing_popularity, existing_decade = row
        new_popularity = max(int(existing_popularity or 0), int(song["popularity"]))
        decade = existing_decade or song["decade"]
        cur.execute(
            """
            UPDATE songs
               SET popularity = ?,
                   decade = ?,
                   audio_url = COALESCE(NULLIF(audio_url, ''), ''),
                   youtube_id = COALESCE(youtube_id, '')
             WHERE id = ?
            """,
            (new_popularity, decade, song_id),
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
            "Unknown",
            song["decade"],
            song["popularity"],
            "",
            "",
        ),
    )
    return cur.lastrowid, True


def upsert_source_row(conn, song_id, source_name, source_popularity, chart_entries=1):
    cur = conn.cursor()
    row = cur.execute(
        "SELECT id, source_popularity, chart_entries FROM song_sources WHERE song_id = ? AND source = ?",
        (song_id, source_name),
    ).fetchone()
    if row:
        existing_id, existing_popularity, existing_entries = row
        cur.execute(
            """
            UPDATE song_sources
               SET source_popularity = ?,
                   chart_entries = ?
             WHERE id = ?
            """,
            (
                max(int(existing_popularity or 0), int(source_popularity or 0)),
                int(existing_entries or 0) + int(chart_entries or 1),
                existing_id,
            ),
        )
        return False

    cur.execute(
        """
        INSERT INTO song_sources (song_id, source, source_popularity, chart_entries)
        VALUES (?, ?, ?, ?)
        """,
        (song_id, source_name, int(source_popularity or 0), int(chart_entries or 1)),
    )
    return True


def record_run(conn, source_name, chart_name, issue_date):
    conn.execute(
        "INSERT OR IGNORE INTO chart_import_runs (source, chart_name, issue_date) VALUES (?, ?, ?)",
        (source_name, chart_name, issue_date),
    )


def last_issue_date(conn, source_name):
    row = conn.execute(
        "SELECT MAX(issue_date) FROM chart_import_runs WHERE source = ?",
        (source_name,),
    ).fetchone()
    if row and row[0]:
        return parse_date(row[0])
    return None


def chart_dates_to_fetch(latest_imported, latest_chart_date, backfill_weeks):
    if latest_imported is None:
        start = latest_chart_date - timedelta(weeks=max(0, backfill_weeks - 1))
    else:
        start = latest_imported + timedelta(days=7)
    if start < DEFAULT_START_DATE:
        start = DEFAULT_START_DATE
    current = start
    while current <= latest_chart_date:
        yield current
        current += timedelta(days=7)


def import_week(conn, chart_name, source_name, chart_date):
    chart = billboard.ChartData(chart_name, date=chart_date.strftime("%Y-%m-%d"))
    if not chart:
        return 0, 0, 0

    # Billboard objects usually expose the canonical chart date after fetch.
    issue_date = getattr(chart, "date", chart_date.strftime("%Y-%m-%d"))
    if isinstance(issue_date, str):
        issue_date_text = issue_date[:10]
    else:
        issue_date_text = chart_date.strftime("%Y-%m-%d")

    if conn.execute(
        "SELECT 1 FROM chart_import_runs WHERE source = ? AND issue_date = ?",
        (source_name, issue_date_text),
    ).fetchone():
        print(f"skip {issue_date_text} (already imported)")
        return 0, 0, 0

    inserted_songs = 0
    updated_songs = 0
    source_rows = 0

    for entry in chart:
        title = (entry.title or "").strip()
        artist = (entry.artist or "").strip()
        if not title or not artist:
            continue

        peak_position = getattr(entry, "peakPos", None) or entry.rank
        weeks_on_chart = getattr(entry, "weeks", None) or 1
        song = {
            "title": title,
            "artist": artist,
            "decade": (chart_date.year // 10) * 10,
            "popularity": calc_popularity(peak_position, weeks_on_chart),
            "source_popularity": calc_popularity(peak_position, weeks_on_chart),
        }

        song_id, created = upsert_song(conn, song)
        if created:
            inserted_songs += 1
        else:
            updated_songs += 1

        if upsert_source_row(conn, song_id, source_name, song["source_popularity"], 1):
            source_rows += 1

    record_run(conn, source_name, chart_name, issue_date_text)
    conn.commit()
    print(f"imported {issue_date_text}: songs={len(chart)} inserted={inserted_songs} updated={updated_songs} new_source_rows={source_rows}")
    return inserted_songs, updated_songs, source_rows


def main():
    parser = argparse.ArgumentParser(description="Incrementally update Canadian Hot 100 data")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "src", "db", "database.sqlite")))
    parser.add_argument("--chart-name", default=DEFAULT_CHART_NAME)
    parser.add_argument("--source-name", default=DEFAULT_SOURCE_NAME)
    parser.add_argument("--backfill-weeks", type=int, default=12, help="If no prior chart_import_runs exist, backfill this many weeks from the latest chart")
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        latest_chart = billboard.ChartData(args.chart_name)
        latest_chart_date = parse_date(latest_chart.date)
        last_date = last_issue_date(conn, args.source_name)

        dates = list(chart_dates_to_fetch(last_date, latest_chart_date, args.backfill_weeks))
        if not dates:
            print("up to date")
            return

        print(f"latest chart date: {latest_chart_date.isoformat()}")
        print(f"last imported date: {last_date.isoformat() if last_date else 'none'}")
        print(f"weeks to process: {len(dates)}")

        total_inserted = total_updated = total_source_rows = 0
        for d in dates:
            inserted, updated, source_rows = import_week(conn, args.chart_name, args.source_name, d)
            total_inserted += inserted
            total_updated += updated
            total_source_rows += source_rows

        print(f"done inserted={total_inserted} updated={total_updated} source_rows={total_source_rows}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
