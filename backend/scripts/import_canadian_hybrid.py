#!/usr/bin/env python3
"""
Hybrid Canadian chart importer for MusicTrivia.

Strategy:
- Use Wikipedia yearly number-one singles pages instead of week-by-week scraping.
- Pre-2007: List_of_number-one_singles_of_YEAR_(Canada)
- 2007+: List_of_Canadian_Hot_100_number-one_singles_of_YEAR

This gives a fast, resumable Canadian seed dataset without getting stuck on a
single weekly chart fetch.
"""

import argparse
import math
import os
import re
import sqlite3
from collections import defaultdict
from datetime import date, datetime
from io import StringIO

import requests
from bs4 import BeautifulSoup

DEFAULT_START_YEAR = 1957
DEFAULT_END_YEAR = date.today().year
DEFAULT_SOURCE_NAME = "wikipedia-canada-number-ones"
DEFAULT_USER_AGENT = "Mozilla/5.0 (MusicTrivia importer)"


def calc_popularity(peak_position, weeks_on_chart, weeks_at_1=0):
    try:
        peak_position = int(peak_position)
    except Exception:
        peak_position = 100
    try:
        weeks_on_chart = int(weeks_on_chart)
    except Exception:
        weeks_on_chart = 1
    try:
        weeks_at_1 = int(weeks_at_1)
    except Exception:
        weeks_at_1 = 0

    peak_comp = 45 * ((100 - peak_position) / 100) ** 1.5
    weeks_comp = 35 * (1 - math.exp(-weeks_on_chart / 25))
    w1_comp = 20 * (1 - math.exp(-weeks_at_1 / 10))
    return min(100, max(0, int(peak_comp + weeks_comp + w1_comp)))


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


def normalize_text(text):
    text = re.sub(r"\[[^\]]*\]", "", text or "")
    text = text.replace("\u2013", "-").replace("\u2014", "-")
    text = text.replace("†", "")
    text = text.replace("“", '"').replace("”", '"').replace("’", "'")
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip(" \t\r\n\"'“”†")


def page_name_for_year(year):
    if year <= 2007:
        return f"List_of_number-one_singles_of_{year}_(Canada)"
    return f"List_of_Canadian_Hot_100_number-one_singles_of_{year}"


def page_url_for_year(year):
    return f"https://en.wikipedia.org/wiki/{page_name_for_year(year)}"


def is_chart_table(table):
    headers = [normalize_text(cell.get_text(" ", strip=True)).lower() for cell in table.find_all("th")[:6]]
    header_blob = " ".join(headers)
    return ("song" in header_blob or "title" in header_blob) and "artist" in header_blob


def extract_chart_entries(table, year):
    rows = table.find_all("tr")
    if not rows:
        return []

    header_cells = rows[0].find_all(["th", "td"])
    header_len = len(header_cells)
    if header_len < 3:
        return []

    entries = []
    current = None

    for tr in rows[1:]:
        cells = [normalize_text(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
        if not cells:
            continue

        # Continuation row: same song/artist as previous row, only date/reference changed.
        if len(cells) <= 2 and current is not None:
            current["weeks_at_1"] += 1
            continue

        song = artist = issue_date = None
        if header_len >= 5 and len(cells) >= 4:
            issue_date = cells[1]
            song = cells[2]
            artist = cells[3]
        elif header_len == 3 and len(cells) >= 3:
            issue_date = cells[0]
            song = cells[1]
            artist = cells[2]
        else:
            # Some tables have odd row shapes; ignore anything we can't identify.
            continue

        song = normalize_text(song)
        artist = normalize_text(artist)
        if not song or not artist:
            continue

        current = {
            "title": song,
            "artist": artist,
            "issue_date": issue_date,
            "year": year,
            "weeks_at_1": 1,
        }
        entries.append(current)

    return entries


def fetch_year(session, year):
    url = page_url_for_year(year)
    resp = session.get(url, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}")
    return resp.text


def collect_hybrid_entries(start_year, end_year, verbose=False):
    session = requests.Session()
    session.headers.update({"User-Agent": DEFAULT_USER_AGENT})

    buckets = defaultdict(lambda: {
        "title": None,
        "artist": None,
        "first_year": None,
        "weeks_at_1": 0,
    })

    years_loaded = 0
    pages_loaded = 0

    for year in range(start_year, end_year + 1):
        years_loaded += 1
        try:
            html = fetch_year(session, year)
        except Exception as exc:
            print(f"skip {year}: {exc}")
            continue

        pages_loaded += 1
        soup = BeautifulSoup(html, "html.parser")
        year_entries = []
        for table in soup.find_all("table", class_=lambda classes: classes and "wikitable" in classes):
            if not is_chart_table(table):
                continue
            year_entries.extend(extract_chart_entries(table, year))

        if verbose:
            print(f"loaded {year}: {len(year_entries)} chart rows")

        for entry in year_entries:
            key = (entry["title"].lower(), entry["artist"].lower())
            bucket = buckets[key]
            bucket["title"] = entry["title"]
            bucket["artist"] = entry["artist"]
            bucket["weeks_at_1"] += entry["weeks_at_1"]
            if bucket["first_year"] is None or year < bucket["first_year"]:
                bucket["first_year"] = year

    prepared = []
    for bucket in buckets.values():
        if not bucket["title"] or not bucket["artist"]:
            continue
        weeks = max(1, int(bucket["weeks_at_1"]))
        decade = (int(bucket["first_year"]) // 10) * 10 if bucket["first_year"] else 2000
        popularity = calc_popularity(1, weeks, weeks)
        prepared.append({
            "title": bucket["title"],
            "artist": bucket["artist"],
            "decade": decade,
            "popularity": popularity,
            "source_popularity": popularity,
            "weeks_on_chart": weeks,
        })

    prepared.sort(key=lambda s: (-s["popularity"], s["title"].lower(), s["artist"].lower()))
    return pages_loaded, prepared


def import_hybrid(conn, start_year, end_year, source_name, dry_run=False, limit=None):
    ensure_schema(conn)
    pages_loaded, prepared = collect_hybrid_entries(start_year, end_year, verbose=False)
    print(f"loaded pages: {pages_loaded}, unique songs: {len(prepared)}")

    if limit is not None:
        prepared = prepared[:limit]
        print(f"limited to {len(prepared)} songs")

    if dry_run:
        for s in prepared[:15]:
            print(f"  {s['title']} — {s['artist']} ({s['decade']}) pop={s['popularity']} weeks#1={s['weeks_on_chart']}")
        return

    inserted = 0
    updated = 0
    source_rows = 0
    cur = conn.cursor()

    for idx, song in enumerate(prepared, 1):
        song_id, created = upsert_song(conn, song)
        inserted += 1 if created else 0
        updated += 0 if created else 1
        cur.execute(
            """
            INSERT OR IGNORE INTO song_sources (song_id, source, source_popularity, chart_entries)
            VALUES (?, ?, ?, ?)
            """,
            (song_id, source_name, song["source_popularity"], max(1, int(song["weeks_on_chart"] or 1))),
        )
        source_rows += cur.rowcount
        if idx % 100 == 0:
            conn.commit()
            print(f"  progress {idx}/{len(prepared)}")

    conn.commit()
    print(f"inserted={inserted} updated={updated} source_rows={source_rows}")


def main():
    parser = argparse.ArgumentParser(description="Import Canadian chart number-ones into MusicTrivia DB")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "src", "db", "database.sqlite")))
    parser.add_argument("--start-year", type=int, default=DEFAULT_START_YEAR)
    parser.add_argument("--end-year", type=int, default=DEFAULT_END_YEAR)
    parser.add_argument("--source-name", default=DEFAULT_SOURCE_NAME)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    conn = sqlite3.connect(db_path)
    try:
        import_hybrid(
            conn,
            start_year=args.start_year,
            end_year=args.end_year,
            source_name=args.source_name,
            dry_run=args.dry_run,
            limit=args.limit,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
