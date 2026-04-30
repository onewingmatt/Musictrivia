#!/usr/bin/env python3
"""
Enrich song genres using MusicBrainz API (free, no API key needed).
Run this after import_billboard.py to fill in genre data.

Usage:
  python enrich_genres.py                    # Enrich all Unknown genres
  python enrich_genres.py --refresh          # Re-enrich all genres
  python enrich_genres.py --limit 100        # Only process 100 artists

MusicBrainz rate limit: ~1 req/sec. For ~9000 unique artists, expect ~2.5 hours.
The script caches progress and can be safely interrupted and resumed.
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'src', 'db', 'database.sqlite')
CACHE_PATH = os.path.join(os.path.dirname(__file__), '.genre_cache.json')

GENRE_MAP = {
    'pop': 'Pop', 'rock': 'Rock', 'hip hop': 'Hip Hop', 'hip-hop': 'Hip Hop',
    'rap': 'Hip Hop', 'r&b': 'R&B', 'rhythm and blues': 'R&B', 'soul': 'R&B',
    'country': 'Country', 'electronic': 'Electronic', 'dance': 'Electronic',
    'edm': 'Electronic', 'house': 'Electronic', 'techno': 'Electronic',
    'jazz': 'Jazz', 'blues': 'Blues', 'folk': 'Folk', 'indie': 'Indie',
    'indie rock': 'Indie', 'indie pop': 'Indie', 'metal': 'Metal',
    'heavy metal': 'Metal', 'punk': 'Punk', 'punk rock': 'Punk',
    'reggae': 'Reggae', 'latin': 'Latin', 'reggaeton': 'Latin',
    'classical': 'Classical', 'funk': 'Funk', 'disco': 'Disco',
    'gospel': 'Gospel', 'alternative': 'Alternative', 'alternative rock': 'Alternative',
    'singer-songwriter': 'Singer-Songwriter', 'k-pop': 'K-Pop', 'korean pop': 'K-Pop',
    'art rock': 'Alternative', 'progressive rock': 'Rock', 'psychedelic': 'Rock',
    'psychedelic rock': 'Rock', 'hard rock': 'Rock', 'soft rock': 'Pop',
    'synthpop': 'Electronic', 'electropop': 'Electronic', 'new wave': 'Alternative',
    'grunge': 'Rock', 'trip hop': 'Electronic', 'drum and bass': 'Electronic',
    'dubstep': 'Electronic', 'trap': 'Hip Hop', 'lo-fi': 'Indie',
    'neo soul': 'R&B', 'contemporary r&b': 'R&B',
    'pop rock': 'Pop', 'pop rap': 'Hip Hop', 'gangsta rap': 'Hip Hop',
    'southern hip hop': 'Hip Hop', 'west coast hip hop': 'Hip Hop',
    'east coast hip hop': 'Hip Hop', 'conscious hip hop': 'Hip Hop',
    'britpop': 'Rock', 'shoegaze': 'Alternative', 'post-punk': 'Alternative',
    'post-rock': 'Alternative', 'emo': 'Alternative', 'ska': 'Rock',
    'bluegrass': 'Country', 'americana': 'Country', 'outlaw country': 'Country',
    'afrobeats': 'R&B', 'afrobeat': 'R&B', 'dancehall': 'Electronic',
    'ambient': 'Electronic', 'chillout': 'Electronic', 'downtempo': 'Electronic',
    'garage rock': 'Rock', 'surf rock': 'Rock', 'rockabilly': 'Rock',
    'rock and roll': 'Rock', "rock 'n' roll": 'Rock',
    'musical theater': 'Other', 'soundtrack': 'Other', 'score': 'Other',
    'new age': 'Other', 'world': 'Other', 'world music': 'Other',
}


def get_genre_musicbrainz(artist_name):
    """Get top canonical genre from MusicBrainz for an artist."""
    url = f"https://musicbrainz.org/ws/2/artist?query=artist:{urllib.parse.quote(artist_name)}&fmt=json&limit=1"
    req = urllib.request.Request(url, headers={
        'User-Agent': 'MusicTrivia/1.0 (hermes-agent; contact: dev@musictrivia.app)'
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        artists = data.get('artists', [])
        if not artists:
            return None
        tags = artists[0].get('tags', [])
        if not tags:
            return None
        # Sort by count descending, find first tag that maps to our genres
        tags.sort(key=lambda t: t.get('count', 0), reverse=True)
        for tag in tags:
            name = tag['name'].lower().strip()
            if name in GENRE_MAP:
                return GENRE_MAP[name]
        # No mapped tag found — return the top tag raw if it seems genre-like
        top_tag = tags[0]['name'].lower().strip()
        return None  # Let it stay Unknown rather than guess
    except urllib.error.HTTPError as e:
        if e.code == 503:
            print("  Rate limited by MusicBrainz, backing off...")
            time.sleep(10)
            return get_genre_musicbrainz(artist_name)  # Retry
        return None
    except Exception:
        return None


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Enrich genres via MusicBrainz')
    parser.add_argument('--refresh', action='store_true', help='Re-enrich all genres (not just Unknown)')
    parser.add_argument('--limit', type=int, default=None, help='Max artists to process')
    parser.add_argument('--db', type=str, default=DB_PATH, help='Path to SQLite database')
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Get distinct artists that need genre enrichment
    if args.refresh:
        c.execute("SELECT DISTINCT artist FROM songs")
    else:
        c.execute("SELECT DISTINCT artist FROM songs WHERE genre = 'Unknown'")
    artists = [row[0] for row in c.fetchall()]
    conn.close()

    print(f"Artists to process: {len(artists)}")
    if args.limit:
        artists = artists[:args.limit]
        print(f"  Limited to: {args.limit}")

    # Load cache
    cache = {}
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            cache = json.load(f)
        print(f"  Cache has {len(cache)} artists already")

    new_artists = [a for a in artists if a not in cache]
    print(f"  New artists to look up: {len(new_artists)}")

    if not new_artists:
        print("All artists already cached. Applying cache to database...")
    else:
        print(f"\nLooking up genres (est. {len(new_artists) * 1.1 / 60:.0f} min)...")
        failed = 0
        for i, artist in enumerate(new_artists):
            genre = get_genre_musicbrainz(artist)
            cache[artist] = genre
            if genre is None:
                failed += 1

            # Save cache every 100 artists
            if (i + 1) % 100 == 0:
                with open(CACHE_PATH, 'w') as f:
                    json.dump(cache, f)
                matched = sum(1 for v in cache.values() if v is not None)
                print(f"  [{i+1}/{len(new_artists)}] Matched: {matched}, Failed: {failed}, Remaining: {len(new_artists) - i - 1}")

            time.sleep(1.1)  # Respect MusicBrainz rate limit

        # Final cache save
        with open(CACHE_PATH, 'w') as f:
            json.dump(cache, f)

    # Apply to database
    print("\nApplying genres to database...")
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    updated = 0
    unknown = 0
    for artist, genre in cache.items():
        if genre:
            c.execute("UPDATE songs SET genre = ? WHERE artist = ?", [genre, artist])
            updated += c.rowcount
        else:
            unknown += 1
    conn.commit()

    # Stats
    c.execute("SELECT genre, COUNT(*) FROM songs GROUP BY genre ORDER BY COUNT(*) DESC")
    genres = c.fetchall()
    conn.close()

    print(f"\nUpdated {updated} song rows. {unknown} artists unmatched.")
    print("\nGenre distribution:")
    for genre, count in genres:
        bar = '#' * (count // 200)
        print(f"  {genre:20s} {count:6d}  {bar}")

    total = sum(count for _, count in genres)
    known = sum(count for genre, count in genres if genre != 'Unknown')
    print(f"\n  {known}/{total} songs have genre assigned ({100*known/total:.1f}%)")


if __name__ == '__main__':
    main()
