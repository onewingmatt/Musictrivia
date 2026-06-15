# Music Trivia

A music trivia game that streams real YouTube audio clips for song-guessing. Comes with a web frontend, a Discord bot for voice-channel games, and data pipelines for importing Billboard Hot 100 chart data.

**Branch note**: The Discord bot lives on the `add-discord-bot-5171993169463143832` branch. The default `scaffold-music-trivia` branch has the web app only. Clone and switch:

```bash
git clone https://github.com/onewingmatt/Musictrivia.git
cd Musictrivia
git checkout add-discord-bot-5171993169463143832
```

## Architecture

```
Musictrivia/
  backend/src/
    index.js              Express server entrypoint, static file serving
    db/setup.js           SQLite schema creation + seed data
    middleware/auth.js    JWT auth middleware (guest-friendly)
    routes/
      auth.js             Register/login with bcrypt + JWT
      quiz.js             Quiz generation, answer checking, config presets
      user.js             User stats endpoint
      admin.js            Admin panel for song management
    bot/
      index.js            Discord.js client init + command registration
      commands/trivia.js  /trivia start and /trivia stop slash commands
      game.js             Voice channel game lifecycle (start, play, grade, end)
      utils.js            Answer matching utility
    services/
      quizService.js      Shared quiz engine (generate + answer check)
    admin.html            Admin panel HTML
    scripts/              Data import and enrichment scripts
  frontend/src/
    main.jsx              React entrypoint
    App.jsx               Router + theme toggle + nav
    api/index.js          Axios instance with JWT interceptor
    context/
      AuthContext.jsx      Auth state (login, register, guest, logout)
      ThemeContext.jsx     Dark/light theme
    pages/
      AuthScreen.jsx       Login / register / guest-play
      DashboardScreen.jsx  Stats dashboard
      QuizSetupScreen.jsx  Genre/decade/source weight sliders, config presets
      QuizRoundScreen.jsx  Audio playback with YouTube iframe + answer submission
      ResultsScreen.jsx    Round results summary
  docker-compose.yml
  Dockerfile
  .env.example
```

### Tech Stack

**Backend**: Node.js, Express 5, SQLite (sqlite3), JWT (jsonwebtoken), bcryptjs, fast-levenshtein, discord.js v14, @discordjs/voice

**Frontend**: React 19, React Router 7, Vite 8, Tailwind CSS 4, Axios, YouTube IFrame Player API

**Infrastructure**: Docker, Docker Compose, yt-dlp (YouTube audio), ffmpeg (audio transcoding), bgutil-pot (PO token provider, optional)

## Features

- **Weighted quiz generation** — genre, decade, and chart source weight sliders (0-5) for fine-grained song selection
- **Multi-source chart data** — songs sourced from Billboard Hot 100, Canadian Hot 100, and Wikipedia Canadian number-ones with per-source popularity scoring
- **Fuzzy answer matching** — Levenshtein-based with substring and separator-split fallbacks for compound artist names
- **YouTube audio playback** — lazy YouTube ID resolution via yt-dlp, hidden 1x1 iframe to prevent title leaks
- **Guest play** — no account needed to play, but registered users get stats tracking and mastered-song filtering
- **Dark/light theme**
- **Saved presets** — save and load quiz configurations
- **Admin panel** — Song management, YouTube ID resolution, report moderation at `/api/admin?secret=<secret>`
- **Random start position** — clips start at a random offset in the song
- **Loop clip** — repeat the audio clip
- **Spelling strictness** — adjustable fuzzy match threshold
- **Popularity range filter** — 0-100 based on chart performance
- **Discord bot** — voice-channel music trivia with `/trivia start` and `/trivia stop`
- **Multiplayer battle mode** — socket.io-based real-time synchronized quiz

## Quick Start

### Docker (production)

```bash
git clone https://github.com/onewingmatt/Musictrivia.git
cd Musictrivia
git checkout add-discord-bot-5171993169463143832

# Copy the env template and edit it
cp .env.example .env
# Edit .env with your secrets (JWT_SECRET, ADMIN_SECRET, DISCORD_TOKEN)

docker compose up -d --build
```

The app runs on port 3001. The database persists in a Docker named volume (`musictrivia-data`) and survives container rebuilds.

### Local Development

```bash
# Install dependencies for both workspaces
npm install

# Backend (terminal 1)
cd backend && npm start

# Frontend (terminal 2)
cd frontend && npm run dev
```

The frontend dev server at `localhost:5173` proxies `/api` to `http://127.0.0.1:3001`. On first start with an empty database, 10 sample songs are seeded automatically.

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and fill in your values:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `DB_PATH` | `/data/database.sqlite` | SQLite database path (inside container) |
| `FRONTEND_DIST` | `/app/frontend/dist` | Built frontend path (inside container) |
| `JWT_SECRET` | `fallback_secret_key_for_dev` | JWT signing secret — change in production |
| `ADMIN_SECRET` | `musictrivia-admin-2026` | Admin panel password |
| `DISCORD_TOKEN` | (unset) | Discord bot token — leave unset to skip bot |
| `GUILD_ID` | (unset) | Guild ID for instant slash command registration |
| `YT_PROXY` | (unset) | HTTP proxy for yt-dlp |

### Quiz Configuration

All quiz settings are adjustable in the web UI:

- **Genre weights**: 21 genres from Pop to Classical, 0-5 slider each
- **Decade weights**: 8 decades (1950s-2020s), 0-5 slider each
- **Source weights**: Billboard US, Canadian Hot 100, Canadian #1s, 0-5 each
- **Popularity range**: Dual min/max slider, 0-100
- **Question count**: 3-20
- **Spelling strictness**: Strict (0), Normal (0.25), or Lenient (0.5)
- **Skip mastered**: Exclude songs you've answered both title and artist correctly
- **Random start**: Play each clip at a random point in the song
- **Loop clip**: Repeat the clip continuously
- **Volume**: 0-100, persisted in localStorage

## API Endpoints

### Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account `{username, password}` |
| POST | `/api/auth/login` | Login, returns JWT `{token, user}` |

### Quiz

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/quiz/generate` | Optional | Generate quiz questions with filters |
| POST | `/api/quiz/answer` | Optional | Submit a guess `{song_id, guessed_title, guessed_artist}` |
| POST | `/api/quiz/resolve-youtube` | Optional | Lazily resolve YouTube ID for a song |
| GET | `/api/quiz/genres` | No | Genre distribution with counts |
| GET | `/api/quiz/decades` | No | Decade distribution with counts |
| GET | `/api/quiz/sources` | No | Chart source distribution |
| GET | `/api/quiz/configs` | Yes | List saved presets |
| POST | `/api/quiz/configs` | Yes | Save a preset `{name, config}` |
| DELETE | `/api/quiz/configs/:id` | Yes | Delete a preset |
| GET | `/api/quiz/export` | Yes | Full database JSON export |
| POST | `/api/quiz/import` | Yes | Full database JSON import |

### User

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/user/stats` | Yes | Accuracy, mastered songs count, total questions |

### Admin

All admin endpoints require `?secret=<ADMIN_SECRET>` or `x-admin-secret` header.

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin` | Admin panel HTML page |
| GET | `/api/admin/reports` | List song reports |
| POST | `/api/admin/reports/:id/dismiss` | Dismiss a report |
| POST | `/api/admin/songs/:id/resolve` | Re-resolve YouTube ID |
| PUT | `/api/admin/songs/:id/youtube` | Manually set YouTube ID |
| POST | `/api/admin/songs/:id/hide` | Hide song from quizzes |
| POST | `/api/admin/songs/:id/unhide` | Unhide a song |
| DELETE | `/api/admin/songs/:id` | Permanently delete song |
| GET | `/api/admin/songs/:id` | Song details |
| GET | `/api/admin/search?q=` | Search songs |
| GET | `/api/admin/stats` | Report counts |

## Discord Bot

The project includes a Discord bot for voice-channel music trivia games.

### Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable intents: Guilds, Guild Voice States, Guild Messages, Message Content
3. Set `DISCORD_TOKEN` in your `.env`
4. (Optional) Set `GUILD_ID` for instant command registration (otherwise global registration takes up to 1 hour)

### Commands

`/trivia start` — options:
- `limit` — Number of questions (1-50, default 5)
- `duration` — Clip play time in seconds (5-60, default 30)
- `answer` — Seconds after clip to accept guesses (5-60, default 30)
- `repeat` — Play clip N times (1-3, default 1)
- `genre` — Genre filter (e.g. "Rock", "Hip Hop")
- `decades` — Decade weights (e.g. "1980:3 1990:5")
- `equal_decades` — Pick from all decades equally
- `random_start` — Start each clip at a random offset (default true)
- `popularity_min` / `popularity_max` — Popularity filter (1-100)

`/trivia stop` — End the current game.

### Audio Streaming

The bot streams YouTube audio through a yt-dlp pipe to ffmpeg pipeline:

```
yt-dlp -f 140 -o - <url>  ->  ffmpeg -c:a libopus  ->  Discord voice
```

This preserves yt-dlp's full auth chain (cookies, PO tokens, TV client negotiation).

### YouTube Blocking on VPS

VPS IPs (Racknerd, DigitalOcean, Oracle) are frequently flagged by YouTube. Mitigation layers:

1. **TV client** — `player_client=tv` avoids SABR streaming issues
2. **PO token provider** — `bgutil-pot` Docker sidecar generates proof-of-origin tokens (included in docker-compose.yml)
3. **Cookies** — Export fresh cookies from a logged-in browser session. Upload to container and lock with `chattr +i` to prevent yt-dlp from overwriting

## Data Pipeline

The app ships with data import scripts in `backend/scripts/`.

### Billboard Hot 100 Import

```bash
pip install billboard.py
python3 backend/scripts/import_billboard.py \
  --db /path/to/database.sqlite \
  --min-popularity 30 \
  --decades 1980,1990,2000
```

Downloads `all.json` from the mhollingshead/billboard-hot-100 repo, deduplicates by title + artist, computes popularity scores, and inserts into SQLite.

### Canadian Chart Data

Two sources:

1. **Wikipedia Canadian #1s** (fast, ~60s) — All #1 singles from 1957-present via yearly Wikipedia pages
2. **Live Billboard Canada** (slow, hours) — Week-by-week Canadian Hot 100 scrape from 2007+

```bash
python3 backend/scripts/import_canadian_hybrid.py \
  --db /path/to/database.sqlite
```

### Genre Enrichment

MusicBrainz-based genre tagging (no API key required):

```bash
python3 backend/scripts/enrich_genres.py \
  --db /path/to/database.sqlite
```

Rate-limited to 1 req/sec. Caches results in `.genre_cache.json` for resumability. ~10,000 artists takes ~3 hours.

### Popularity Scoring

Songs are scored 0-100 based on chart performance:

```
peak_comp = 55 * ((100 - peak_position) / 100) ^ 1.5    # 0-55
weeks_comp = 30 * (1 - e^(-weeks_on_chart / 25))          # 0-30
number_one_bonus = 15 if peak_position == 1 else 0          # 0 or 15
popularity = peak_comp + weeks_comp + number_one_bonus
```

Songs that appear on multiple charts get blended popularity at query time.

## Answer Matching

The `isCorrectGuess` function uses three layered strategies:

1. **Levenshtein fuzzy** — edit distance / max length <= threshold (default 0.25)
2. **Substring match** — shorter string is >= 40% of longer string
3. **Separator split** — split on `&`, `feat.`, `and`, `/`, `x`, `,` and check each part

A `normalize()` helper strips punctuation and collapses whitespace before comparison.

## Database Schema

```sql
users           (id, username, password_hash, created_at)
songs           (id, title, artist, genre, decade, popularity, audio_url, youtube_id, hidden)
song_sources    (id, song_id, source, source_popularity, chart_entries)
user_answers    (id, user_id, song_id, guessed_title, guessed_artist,
                 is_title_correct, is_artist_correct, points_awarded, created_at)
quiz_configs    (id, user_id, name, config_json, created_at)
song_reports    (id, song_id, user_id, reason, note, created_at)
```

## Multiplayer Battle Mode

The app includes a real-time multiplayer battle mode using Socket.IO. Players create or join rooms with a 4-letter code and play synchronized quiz rounds with:

- Per-round genre/decade hints with score penalty
- Audio sync with ready-check and countdown timer
- First-correct bonus points
- Host migration on disconnect
- Reconnection support (60-second grace window)

Battle mode is a separate code path from single-player. The shared quiz engine lives in `backend/src/services/quizService.js`.

## Deployment

### Docker

```bash
cp .env.example .env
# Edit .env with your secrets

docker compose up -d --build

# Verify
curl http://localhost:3001/health
```

The database survives container rebuilds — it's stored in a Docker named volume (`musictrivia-data`). To access it from the host:

```bash
docker volume inspect musictrivia_musictrivia-data
```

### Reverse Proxy

The app is designed to run behind a reverse proxy (Caddy, Nginx, Traefik, Pangolin). Point your proxy at `http://localhost:3001`. The docker-compose.yml has no proxy-specific labels by default — add your own as needed.

### Database Backups

```bash
# Get an auth token (captures the JWT into $TOKEN)
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"your-username","password":"your-password"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Export all data using the token
curl -s http://localhost:3001/api/quiz/export \
  -H "Authorization: Bearer $TOKEN" > backup.json
```

You can also use the Export/Import buttons in the web dashboard.

## Development Notes

- Frontend dev server at `localhost:5173` proxies `/api` to the backend at `:3001`
- Backend logs go to stdout and a log file next to the database
- The `hidden` column on songs (1 = excluded from quizzes) is the reporting mechanism
- YouTube IDs are cached in the `songs.youtube_id` column after first resolution
- The Discord bot uses dual command registration (global + guild) for fast testing
- `@discordjs/opus` requires `libopus-dev` on the system for local dev (Docker handles this)

## License

ISC
