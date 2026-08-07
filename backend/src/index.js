const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const LOG_FILE = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) + '/musictrivia.log' : '/tmp/musictrivia.log';
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
['log','error','warn'].forEach(method => {
    const original = console[method];
    console[method] = (...args) => {
        original.apply(console, args);
        logStream.write(`[${new Date().toISOString()}] [${method.toUpperCase()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
    };
});
const { initDb } = require('./db/setup');
const { startBot } = require('./bot/index');

const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quiz');
const userRoutes = require('./routes/user');

const app = express();
const PORT = process.env.PORT || 3001;
const frontendDist = process.env.FRONTEND_DIST || path.resolve(__dirname, '../../frontend/dist');

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/quiz', quizRoutes);
app.use('/api/user', userRoutes);

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// Serve the generated song list (regenerated into the DB dir by scripts/gen_list.js)
app.get('/songs-list.txt', (req, res) => {
    const listPath = process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'musictrivia-songs.txt') : '';
    if (listPath && fs.existsSync(listPath)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(listPath);
    }
    res.status(404).send('Song list not generated yet. Run scripts/gen_list.js in the backend.');
});

if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(frontendDist, 'index.html'));
    });
}

// Start
initDb().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
    // Start Discord bot if token is provided
    startBot();
}).catch(err => {
    console.error('Failed to initialize database', err);
});
