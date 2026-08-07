const fs = require('fs');
const s = require('sqlite3');
const d = new s.Database('/data/database.sqlite');

const OUT = '/data/musictrivia-songs.txt';

d.all(`SELECT title, artist, popularity, us_popularity, ca_popularity, peak_position, weeks_on_chart, weeks_at_1, decade,
              CASE WHEN youtube_id IS NOT NULL AND youtube_id != '' THEN 1 ELSE 0 END AS has_yt
       FROM songs ORDER BY us_popularity DESC, peak_position ASC, weeks_on_chart DESC, title ASC`, [], (e, rows) => {
  if (e) { console.error(e.message); process.exit(1); }
  const lines = [];
  lines.push('MusicTrivia — full song list (34,785 songs)');
  lines.push('rank (US) | US pop | CA pop | YT(resolved) | title — artist (peak, weeks, weeks@#1, decade)');
  lines.push('');
  rows.forEach((r, i) => {
    const yt = r.has_yt ? 'YT' : '--';
    lines.push(`${String(i + 1).padStart(5)} | ${String(r.us_popularity).padStart(3)} | ${String(r.ca_popularity).padStart(3)} | ${yt} | ${r.title} — ${r.artist} (peak #${r.peak_position ?? '?'}, ${r.weeks_on_chart ?? '?'}w, #1x${r.weeks_at_1 ?? 0}, ${r.decade ?? '?'}s)`);
  });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log('wrote', rows.length, 'rows to', OUT);
  console.log('resolved YT:', rows.filter(r => r.has_yt).length);
  d.close();
});
