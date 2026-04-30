#!/usr/bin/env python3
"""
Import Billboard Hot 100 chart data into the Music Trivia SQLite database.

Data source: https://github.com/mhollingshead/billboard-hot-100
  - Downloads all.json (full historical Hot 100, updated daily)
  - Deduplicates songs, computes popularity from chart performance
  - Infers decade from first chart appearance
  - Optionally enriches genre via Last.fm API (artist.getTopTags)
  - Resolves YouTube video IDs via yt-dlp search

Usage:
  # Basic import (no genre, no YouTube IDs):
  python import_billboard.py

  # With Last.fm genre enrichment (get free key at https://www.last.fm/api/account/create):
  LASTFM_API_KEY=your_key python import_billboard.py --genre

  # Also resolve YouTube IDs (slow, ~1-2 sec per song):
  python import_billboard.py --genre --youtube

  # Filter by decade or popularity:
  python import_billboard.py --min-popularity 50 --decades 1980,1990,2000

  # Limit number of songs (for testing):
  python import_billboard.py --limit 500
"""

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from collections import Counter

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'src', 'db', 'database.sqlite')
BILLBOARD_URL = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/all.json'

# Genre mapping: Last.fm tags -> our canonical genres
GENRE_MAP = {
    'pop': 'Pop',
    'rock': 'Rock',
    'hip hop': 'Hip Hop',
    'hip-hop': 'Hip Hop',
    'rap': 'Hip Hop',
    'r&b': 'R&B',
    'rhythm and blues': 'R&B',
    'soul': 'R&B',
    'country': 'Country',
    'electronic': 'Electronic',
    'dance': 'Electronic',
    'edm': 'Electronic',
    'house': 'Electronic',
    'techno': 'Electronic',
    'trance': 'Electronic',
    'dubstep': 'Electronic',
    'jazz': 'Jazz',
    'blues': 'Blues',
    'folk': 'Folk',
    'indie': 'Indie',
    'indie rock': 'Indie',
    'indie pop': 'Indie',
    'metal': 'Metal',
    'heavy metal': 'Metal',
    'punk': 'Punk',
    'punk rock': 'Punk',
    'reggae': 'Reggae',
    'latin': 'Latin',
    'reggaeton': 'Latin',
    'classical': 'Classical',
    'funk': 'Funk',
    'disco': 'Disco',
    'gospel': 'Gospel',
    'alternative': 'Alternative',
    'alternative rock': 'Alternative',
    'singer-songwriter': 'Singer-Songwriter',
    'k-pop': 'K-Pop',
    'korean': 'K-Pop',
}

CANONICAL_GENRES = sorted(set(GENRE_MAP.values()))


def download_billboard_data():
    """Download all.json from the billboard-hot-100 repo."""
    print("Downloading Billboard Hot 100 data...")
    tmp_path = '/tmp/billboard_all.json'
    if os.path.exists(tmp_path):
        print(f"  Using cached {tmp_path}")
    else:
        urllib.request.urlretrieve(BILLBOARD_URL, tmp_path)
        print(f"  Downloaded to {tmp_path}")
    with open(tmp_path) as f:
        return json.load(f)


def parse_songs(data, min_popularity=0, decades=None, limit=None):
    """Parse Billboard data into deduplicated song records with popularity scores."""
    songs = {}
    for week in data:
        for entry in week['data']:
            key = (entry['song'], entry['artist'])
            if key not in songs:
                songs[key] = {
                    'song': entry['song'],
                    'artist': entry['artist'],
                    'peak_position': entry['peak_position'],
                    'weeks_on_chart': entry['weeks_on_chart'],
                    'first_date': week['date'],
                }
            else:
                songs[key]['peak_position'] = min(songs[key]['peak_position'], entry['peak_position'])
                songs[key]['weeks_on_chart'] = max(songs[key]['weeks_on_chart'], entry['weeks_on_chart'])

    # Compute popularity and decade
    for s in songs.values():
        # Peak component (0-55): exponential reward at the very top
        # #1 = 55, #2 = 42, #5 = 30, #10 = 22, #20 = 14, #50 = 4, #100 = 0
        peak_comp = 55 * ((100 - s['peak_position']) / 100) ** 1.5
        # #1 bonus: extra 15 points for reaching #1
        number_one_bonus = 15 if s['peak_position'] == 1 else 0
        # Weeks component (0-30): exponential so long runners separate
        # 1 week = 2, 10 weeks = 10, 30 weeks = 18, 60 weeks = 25, 90+ weeks = 30
        weeks_comp = 30 * (1 - math.exp(-s['weeks_on_chart'] / 25))
        s['popularity'] = min(100, max(0, int(peak_comp + number_one_bonus + weeks_comp)))
        year = int(s['first_date'][:4])
        s['decade'] = (year // 10) * 10

    # Apply filters
    result = list(songs.values())
    if min_popularity > 0:
        result = [s for s in result if s['popularity'] >= min_popularity]
    if decades:
        decade_set = set(int(d) for d in decades.split(','))
        result = [s for s in result if s['decade'] in decade_set]

    # Sort by popularity descending for consistent ordering
    result.sort(key=lambda x: -x['popularity'])

    if limit:
        result = result[:limit]

    print(f"  Parsed {len(result)} songs (after filters)")
    return result


def get_genre_from_lastfm(artist, api_key):
    """Get the top genre for an artist from Last.fm."""
    url = f"http://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&artist={urllib.parse.quote(artist)}&api_key={api_key}&format=json"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'MusicTrivia/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        tags = data.get('toptags', {}).get('tag', [])
        if not tags:
            return None
        # Find first tag that maps to a canonical genre
        for tag in tags:
            name = tag['name'].lower().strip()
            if name in GENRE_MAP:
                return GENRE_MAP[name]
        return None
    except Exception:
        return None


def get_youtube_id(song, artist):
    """Search YouTube for a song and return the video ID."""
    import subprocess
    query = f"{song} {artist} official"
    try:
        result = subprocess.run(
            ['yt-dlp', '--flat-playlist', '--print', 'id', '--match-filter', 'duration<600',
             f'ytsearch1:{query}'],
            capture_output=True, text=True, timeout=10
        )
        vid = result.stdout.strip()
        if vid and len(vid) == 11:
            return vid
    except Exception:
        pass
    return None


def import_to_db(songs, db_path, genre_cache=None):
    """Insert songs into the SQLite database."""
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Ensure the songs table has the right columns
    c.execute("PRAGMA table_info(songs)")
    columns = {row[1] for row in c.fetchall()}
    
    if 'youtube_id' not in columns:
        c.execute("ALTER TABLE songs ADD COLUMN youtube_id TEXT")
    if 'peak_position' not in columns:
        c.execute("ALTER TABLE songs ADD COLUMN peak_position INTEGER")
    if 'weeks_on_chart' not in columns:
        c.execute("ALTER TABLE songs ADD COLUMN weeks_on_chart INTEGER")

    inserted = 0
    skipped = 0
    for s in songs:
        genre = s.get('genre', 'Unknown')
        youtube_id = s.get('youtube_id')
        
        try:
            c.execute(
                """INSERT OR IGNORE INTO songs 
                   (title, artist, genre, decade, popularity, audio_url, youtube_id, peak_position, weeks_on_chart)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [s['song'], s['artist'], genre, s['decade'], s['popularity'],
                 youtube_id or '', youtube_id, s['peak_position'], s['weeks_on_chart']]
            )
            if c.rowcount > 0:
                inserted += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"  Error inserting {s['song']}: {e}")
            skipped += 1

    conn.commit()
    conn.close()
    print(f"  Inserted: {inserted}, Skipped (duplicates): {skipped}")


def main():
    parser = argparse.ArgumentParser(description='Import Billboard Hot 100 data')
    parser.add_argument('--genre', action='store_true', help='Enrich genre via Last.fm API')
    parser.add_argument('--youtube', action='store_true', help='Resolve YouTube IDs via yt-dlp')
    parser.add_argument('--min-popularity', type=int, default=0, help='Minimum popularity score (0-100)')
    parser.add_argument('--decades', type=str, default=None, help='Comma-separated decades (e.g. 1980,1990,2000)')
    parser.add_argument('--limit', type=int, default=None, help='Max songs to import')
    parser.add_argument('--db', type=str, default=DB_PATH, help='Path to SQLite database')
    args = parser.parse_args()

    data = download_billboard_data()
    songs = parse_songs(data, args.min_popularity, args.decades, args.limit)

    # Genre enrichment
    if args.genre:
        api_key = os.environ.get('LASTFM_API_KEY')
        if not api_key:
            print("ERROR: --genre requires LASTFM_API_KEY env var")
            print("Get a free key at: https://www.last.fm/api/account/create")
            sys.exit(1)
        
        genre_cache = {}
        cache_path = os.path.join(os.path.dirname(__file__), '.genre_cache.json')
        if os.path.exists(cache_path):
            with open(cache_path) as f:
                genre_cache = json.load(f)
            print(f"  Loaded genre cache ({len(genre_cache)} artists)")

        print("Enriching genres from Last.fm...")
        artists = set(s['artist'] for s in songs)
        new_artists = artists - set(genre_cache.keys())
        print(f"  {len(new_artists)} new artists to look up")

        for i, artist in enumerate(new_artists):
            genre = get_genre_from_lastfm(artist, api_key)
            genre_cache[artist] = genre
            if (i + 1) % 50 == 0:
                print(f"  Progress: {i+1}/{len(new_artists)}")
                # Save cache periodically
                with open(cache_path, 'w') as f:
                    json.dump(genre_cache, f)
            time.sleep(0.25)  # Rate limit

        # Final cache save
        with open(cache_path, 'w') as f:
            json.dump(genre_cache, f)

        # Apply genres
        genre_unknown = 0
        for s in songs:
            s['genre'] = genre_cache.get(s['artist']) or 'Unknown'
            if s['genre'] == 'Unknown':
                genre_unknown += 1
        print(f"  Genre assigned: {len(songs) - genre_unknown} matched, {genre_unknown} unknown")

    else:
        # Without genre enrichment, mark all as Unknown
        for s in songs:
            s['genre'] = 'Unknown'

    # YouTube ID resolution
    if args.youtube:
        print("Resolving YouTube IDs (this is slow, ~1-2 sec per song)...")
        resolved = 0
        for i, s in enumerate(songs):
            yt_id = get_youtube_id(s['song'], s['artist'])
            if yt_id:
                s['youtube_id'] = yt_id
                resolved += 1
            if (i + 1) % 20 == 0:
                print(f"  Progress: {i+1}/{len(songs)} ({resolved} resolved)")
        print(f"  YouTube IDs resolved: {resolved}/{len(songs)}")

    # Import to database
    db_path = os.path.abspath(args.db)
    print(f"Importing to {db_path}...")
    import_to_db(songs, db_path)

    # Print stats
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM songs")
    total = c.fetchone()[0]
    c.execute("SELECT genre, COUNT(*) FROM songs GROUP BY genre ORDER BY COUNT(*) DESC")
    genres = c.fetchall()
    c.execute("SELECT decade, COUNT(*) FROM songs GROUP BY decade ORDER BY decade")
    decades = c.fetchall()
    conn.close()

    print(f"\nDatabase now has {total} total songs")
    print("\nBy genre:")
    for genre, count in genres:
        print(f"  {genre}: {count}")
    print("\nBy decade:")
    for decade, count in decades:
        print(f"  {decade}s: {count}")

    print(f"\nAvailable genres for quiz setup: {', '.join(CANONICAL_GENRES)}")


if __name__ == '__main__':
    import urllib.parse
    main()
