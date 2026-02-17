/**
 * Radio PS — Pepe Shneyne Broadcasting
 * Node.js + WebSocket.  Listeners hear audio via /stream/:id
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

// ─── Папки ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Аккаунты ───────────────────────────────────────────────────────────
const ACCOUNTS = {
  'ps':           { pass: 'faa', role: 'mod', display: 'PS' },
  'pepe shneyne': { pass: 'faa', role: 'mod', display: 'Pepe Shneyne' },
};
const LISTENERS = {
  'user':     '1234',
  'listener': '1234',
  'guest':    '0000',
};

// ─── Состояние радио ────────────────────────────────────────────────────
let radioState = {
  state:        'offline',
  currentTrack: null,
  thoughtText:  '',
  tickerText:   '',
  queue:        [],
  modOnline:    false,
};

const sessions = new Map();  // token → { username, role }
const trackMap = new Map();  // trackId → { filename, filepath }

function makeToken() { return crypto.randomBytes(24).toString('hex'); }

// Публичный payload — без внутренних filename, только audioUrl
function publicState() {
  const s = { ...radioState };
  if (s.currentTrack) {
    s.currentTrack = { ...s.currentTrack };
    if (s.currentTrack.type === 'audio') {
      s.currentTrack.audioUrl = `/stream/${s.currentTrack.id}`;
      delete s.currentTrack.filename;
    }
  }
  s.queue = s.queue.map(item => {
    if (item.type === 'audio') {
      const { filename, ...rest } = item;
      return { ...rest, audioUrl: `/stream/${item.id}` };
    }
    return item;
  });
  return s;
}

function broadcastState() {
  const data = JSON.stringify({ type: 'state', payload: publicState() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

// ─── Multer ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const safe = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('audio/') ? cb(null, true) : cb(new Error('Только аудио'))
});

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authMw(req, res, next) {
  const t = req.headers['x-session-token'];
  if (!t || !sessions.has(t)) return res.status(401).json({ error: 'Unauthorized' });
  req.session = sessions.get(t);
  next();
}
function modOnly(req, res, next) {
  if (req.session.role !== 'mod') return res.status(403).json({ error: 'Mod only' });
  next();
}

// ─── /stream/:id — аудиостриминг с HTTP Range support ───────────────────
app.get('/stream/:id', authMw, (req, res) => {
  const info = trackMap.get(req.params.id);
  if (!info) return res.status(404).send('Not found');

  const fp = info.filepath;
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');

  const stat  = fs.statSync(fp);
  const total = stat.size;
  const range = req.headers.range;

  const ext  = path.extname(fp).toLowerCase();
  const mime = {
    '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav',
    '.flac':'audio/flac', '.m4a':'audio/mp4', '.aac':'audio/aac',
    '.opus':'audio/opus', '.webm':'audio/webm',
  }[ext] || 'audio/mpeg';

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(s, 10);
    const end    = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   mime,
      'Cache-Control':  'no-cache',
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'no-cache',
    });
    fs.createReadStream(fp).pipe(res);
  }
});

// ─── /api/login ─────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body;
  const key = username.trim().toLowerCase();

  if (ACCOUNTS[key] && ACCOUNTS[key].pass === password) {
    const acc   = ACCOUNTS[key];
    const token = makeToken();
    sessions.set(token, { username: acc.display, role: 'mod' });
    radioState.modOnline = true;
    if (radioState.state === 'offline') radioState.state = 'choosing';
    broadcastState();
    return res.json({ token, role: 'mod', username: acc.display });
  }

  if (LISTENERS[key] !== undefined && LISTENERS[key] === password) {
    const token = makeToken();
    sessions.set(token, { username, role: 'listener' });
    return res.json({ token, role: 'listener', username });
  }

  res.status(401).json({ error: 'Неверный логин или пароль' });
});

// ─── /api/logout ────────────────────────────────────────────────────────
app.post('/api/logout', authMw, (req, res) => {
  if (req.session.role === 'mod') {
    radioState.modOnline    = false;
    radioState.state        = 'offline';
    radioState.currentTrack = null;
    radioState.thoughtText  = '';
    radioState.tickerText   = '';
    broadcastState();
  }
  sessions.delete(req.headers['x-session-token']);
  res.json({ ok: true });
});

// ─── /api/upload (в очередь) ────────────────────────────────────────────
app.post('/api/upload', authMw, modOnly, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const id   = crypto.randomBytes(8).toString('hex');
  const item = {
    id, type: 'audio',
    name:     (req.body.title || req.file.originalname).slice(0, 80),
    filename: req.file.filename,
  };
  trackMap.set(id, { filename: item.filename, filepath: path.join(UPLOADS_DIR, item.filename) });
  radioState.queue.push(item);
  if (radioState.state === 'offline') radioState.state = 'choosing';
  broadcastState();
  res.json({ ok: true, id });
});

// ─── /api/queue/text ────────────────────────────────────────────────────
app.post('/api/queue/text', authMw, modOnly, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Пустой текст' });
  const item = {
    id:   crypto.randomBytes(8).toString('hex'),
    type: 'text',
    text: text.trim(),
    name: text.trim().slice(0, 60),
  };
  radioState.queue.push(item);
  if (radioState.state === 'offline') radioState.state = 'choosing';
  broadcastState();
  res.json({ ok: true, id: item.id });
});

// ─── /api/play-now ──────────────────────────────────────────────────────
app.post('/api/play-now', authMw, modOnly, upload.single('audio'), (req, res) => {
  const { type, text, title } = req.body;
  const id = crypto.randomBytes(8).toString('hex');

  if (type === 'audio') {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const track = {
      id, type: 'audio',
      name:     (title || req.file.originalname).slice(0, 80),
      filename: req.file.filename,
    };
    trackMap.set(id, { filename: track.filename, filepath: path.join(UPLOADS_DIR, track.filename) });
    radioState.currentTrack = track;
    radioState.state        = 'playing';
    radioState.tickerText   = `▶ ${track.name} ◀ RADIO PS ▶ 99.9 FM ◀`;
    radioState.thoughtText  = track.name;

  } else if (type === 'text') {
    if (!text?.trim()) return res.status(400).json({ error: 'Пустой текст' });
    radioState.currentTrack = { id, type: 'text', text: text.trim(), name: text.trim().slice(0, 60) };
    radioState.state        = 'text';
    radioState.thoughtText  = text.trim();
    radioState.tickerText   = '';
  } else {
    return res.status(400).json({ error: 'Неверный тип' });
  }

  broadcastState();
  res.json({ ok: true, id });
});

// ─── /api/next ──────────────────────────────────────────────────────────
app.post('/api/next', authMw, modOnly, (req, res) => {
  if (radioState.queue.length === 0) {
    radioState.state        = radioState.modOnline ? 'choosing' : 'offline';
    radioState.currentTrack = null;
    radioState.thoughtText  = '';
    radioState.tickerText   = '';
    broadcastState();
    return res.json({ ok: true, empty: true });
  }
  const item = radioState.queue.shift();
  radioState.currentTrack = item;
  if (item.type === 'audio') {
    radioState.state       = 'playing';
    radioState.tickerText  = `▶ ${item.name} ◀ RADIO PS ▶ 99.9 FM ◀`;
    radioState.thoughtText = item.name;
  } else {
    radioState.state       = 'text';
    radioState.thoughtText = item.text;
    radioState.tickerText  = '';
  }
  broadcastState();
  res.json({ ok: true });
});

// ─── /api/stop ──────────────────────────────────────────────────────────
app.post('/api/stop', authMw, modOnly, (req, res) => {
  radioState.state        = radioState.modOnline ? 'choosing' : 'offline';
  radioState.currentTrack = null;
  radioState.thoughtText  = '';
  radioState.tickerText   = '';
  broadcastState();
  res.json({ ok: true });
});

// ─── /api/track-ended (сигнал от мода — трек закончился) ────────────────
app.post('/api/track-ended', authMw, modOnly, (req, res) => {
  if (radioState.queue.length > 0) {
    const item = radioState.queue.shift();
    radioState.currentTrack = item;
    if (item.type === 'audio') {
      radioState.state       = 'playing';
      radioState.tickerText  = `▶ ${item.name} ◀ RADIO PS ▶ 99.9 FM ◀`;
      radioState.thoughtText = item.name;
    } else {
      radioState.state       = 'text';
      radioState.thoughtText = item.text;
      radioState.tickerText  = '';
    }
  } else {
    radioState.state        = radioState.modOnline ? 'choosing' : 'offline';
    radioState.currentTrack = null;
    radioState.thoughtText  = '';
    radioState.tickerText   = '';
  }
  broadcastState();
  res.json({ ok: true });
});

// ─── /api/queue/:id DELETE ──────────────────────────────────────────────
app.delete('/api/queue/:id', authMw, modOnly, (req, res) => {
  radioState.queue = radioState.queue.filter(i => i.id !== req.params.id);
  broadcastState();
  res.json({ ok: true });
});

// ─── WebSocket ───────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', payload: publicState() }));
  ws.on('error', () => {});
});

// ─── Очистка старых файлов ───────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  try {
    fs.readdirSync(UPLOADS_DIR).forEach(f => {
      const fp   = path.join(UPLOADS_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(fp);
    });
  } catch(e) {}
}, 60 * 60 * 1000);

// ─── Запуск ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n📻  Radio PS запущен!`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`\n    MOD:       PS / faa`);
  console.log(`    Слушатель: user / 1234\n`);
});
