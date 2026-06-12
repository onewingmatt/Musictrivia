/**
 * Batch resolve YouTube IDs for songs missing them.
 * Uses yt-dlp search (same as quizService.js) to find official audio for each song.
 *
 * Usage:
 *   node batch_resolve_youtube.js [limit] [delay_ms]
 *
 *   limit     — max songs to process (default 100)
 *   delay_ms  — ms between requests (default 1500, YouTube rate limits aggressively)
 */
const { spawnSync } = require('child_process');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'src', 'db', 'database.sqlite');
const sqlite3 = require('sqlite3').verbose();

const limit = parseInt(process.argv[2]) || 100;
const delay = parseInt(process.argv[3]) || 1500;

const db = new sqlite3.Database(DB_PATH);

function escapeShell(str) {
    return str.replace(/"/g, '\\"').replace(/'/g, "\\'");
}

function searchYoutube(title, artist) {
    const queries = [
        `${title} ${artist} official audio`,
        `${title} ${artist} official`,
        `${title} ${artist}`,
    ];

    for (const query of queries) {
        try {
            const result = spawnSync('yt-dlp', [
                '--flat-playlist',
                '--print', 'id',
                '--match-filter', 'duration<600',
                `ytsearch1:${query}`,
            ], { timeout: 15000, encoding: 'utf8' });

            if (result.status === 0 && result.stdout.trim().length === 11) {
                return result.stdout.trim();
            }
        } catch (e) {
            // try next query
        }
    }
    return null;
}

let processed = 0;
let found = 0;
let skipped = 0;
let errors = 0;

db.all(
    `SELECT id, title, artist FROM songs
     WHERE (audio_url IS NULL OR audio_url = '')
       AND (youtube_id IS NULL OR youtube_id = '')
     LIMIT ?`,
    [limit],
    (err, rows) => {
        if (err) {
            console.error('Query error:', err);
            db.close();
            return;
        }

        console.log(`Found ${rows.length} songs missing YouTube IDs\n`);

        function processNext(index) {
            if (index >= rows.length) {
                console.log(`\nDone. Processed: ${processed}, Found: ${found}, Skipped: ${skipped}, Errors: ${errors}`);
                db.close();
                return;
            }

            const song = rows[index];
            const query = `${song.title} ${song.artist}`;
            process.stdout.write(`[${index + 1}/${rows.length}] ${query}... `);

            try {
                const ytId = searchYoutube(song.title, song.artist);
                processed++;

                if (ytId) {
                    db.run(
                        'UPDATE songs SET youtube_id = ?, audio_url = ? WHERE id = ?',
                        [ytId, ytId, song.id],
                        (err) => {
                            if (err) {
                                console.error(`DB error: ${err.message}`);
                                errors++;
                            } else {
                                console.log(`✓ ${ytId}`);
                                found++;
                            }
                            setTimeout(() => processNext(index + 1), delay);
                        }
                    );
                } else {
                    console.log(`✗ not found`);
                    skipped++;
                    setTimeout(() => processNext(index + 1), delay);
                }
            } catch (e) {
                console.error(`Error: ${e.message}`);
                errors++;
                setTimeout(() => processNext(index + 1), delay);
            }
        }

        processNext(0);
    }
);
