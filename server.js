/**
 * Radio PS — Pepe Shneyne Broadcasting
 * Node.js server with WebSocket real-time sync
 */

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ─── Настройка папок ───────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ─── Аккаунты ─────────────────────────────────────────────────────────
const ACCOUNTS = {
  'PS':           { pass: 'faa',  role: 'mod' },
  'Pepe Shneyne': { pass: 'faa',  role: 'mod' },
};

// Можно добавить любое количество слушателей:
const LISTENERS = {
  'user':     '1234',
  'listener': '1234',
  'guest':    '0000',
};

// ─── Состояние радио ──────────────────────────────────────────────────
let radioState = {
  state: 'offline',     // offline | choosing | playing | text
  currentTrack: null,   // { id, name, type:'audio'|'text', text:? }
  thoughtText: '',
  tickerText:  '',
  queue: [],            // [{id, name, type, text?, filename?}]
  modOnline: false,
};

// Сессии: token → { username, role }
const sessions = new Map();

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─── Multer (загрузка аудио) ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const safe = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Только аудио файлы'));
  }
});

// ─── Middleware ───────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Middleware: проверяем токен
function authMiddleware(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.session = sessions.get(token);
  next();
}

function modOnly(req, res, next) {
  if (req.session.role !== 'mod') return res.status(403).json({ error: 'Mod only' });
  next();
}

// ─── REST API ─────────────────────────────────────────────────────────

// Логин
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Нет данных' });

  const key = Object.keys(ACCOUNTS).find(k => k.toLowerCase() === username.toLowerCase());
  if (key && ACCOUNTS[key].pass === password) {
    const token = makeToken();
    sessions.set(token, { username: key, role: 'mod' });
    if (radioState.state === 'offline') {
      radioState.state = 'choosing';
      radioState.modOnline = true;
      broadcast({ type: 'state', payload: radioState });
    }
    return res.json({ token, role: 'mod', username: key });
  }

  // Проверяем слушателей
  const lKey = Object.keys(LISTENERS).find(k => k.toLowerCase() === username.toLowerCase());
  if (lKey && LISTENERS[lKey] === password) {
    const token = makeToken();
    sessions.set(token, { username: lKey, role: 'listener' });
    return res.json({ token, role: 'listener', username: lKey });
  }

  return res.status(401).json({ error: 'Неверный логин или пароль' });
});

// Выход
app.post('/api/logout', authMiddleware, (req, res) => {
  if (req.session.role === 'mod') {
    radioState.modOnline = false;
    radioState.state = 'offline';
    radioState.currentTrack = null;
    radioState.thoughtText = '';
    radioState.tickerText = '';
    broadcast({ type: 'state', payload: radioState });
  }
  sessions.delete(req.headers['x-session-token']);
  res.json({ ok: true });
});

// Текущее состояние (для нового подключения)
app.get('/api/state', authMiddleware, (req, res) => {
  res.json(radioState);
});

// Загрузить аудио в очередь
app.post('/api/upload', authMiddleware, modOnly, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const item = {
    id:       crypto.randomBytes(8).toString('hex'),
    type:     'audio',
    name:     req.body.title || req.file.originalname,
    filename: req.file.filename,
  };
  radioState.queue.push(item);
  if (radioState.state === 'offline') {
    radioState.state = 'choosing';
  }
  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true, item });
});

// Добавить текст в очередь
app.post('/api/queue/text', authMiddleware, modOnly, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Пустой текст' });
  const item = {
    id:   crypto.randomBytes(8).toString('hex'),
    type: 'text',
    text: text.trim(),
    name: text.trim().slice(0, 50),
  };
  radioState.queue.push(item);
  if (radioState.state === 'offline') radioState.state = 'choosing';
  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true, item });
});

// Воспроизвести сейчас (минуя очередь)
app.post('/api/play-now', authMiddleware, modOnly, upload.single('audio'), (req, res) => {
  const { type, text, title } = req.body;

  if (type === 'audio') {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    radioState.currentTrack = {
      id: crypto.randomBytes(8).toString('hex'),
      type: 'audio',
      name: title || req.file.originalname,
      filename: req.file.filename,
    };
    radioState.state = 'playing';
    radioState.tickerText = `▶ ${radioState.currentTrack.name} ◀ RADIO PS ▶ 99.9 FM ◀`;
    radioState.thoughtText = radioState.currentTrack.name;
  } else if (type === 'text') {
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустой текст' });
    radioState.currentTrack = {
      id: crypto.randomBytes(8).toString('hex'),
      type: 'text',
      text: text.trim(),
      name: text.trim().slice(0, 50),
    };
    radioState.state = 'text';
    radioState.thoughtText = text.trim();
    radioState.tickerText = '';
  }

  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true });
});

// Следующий трек из очереди
app.post('/api/next', authMiddleware, modOnly, (req, res) => {
  if (radioState.queue.length === 0) {
    radioState.state = 'choosing';
    radioState.currentTrack = null;
    radioState.thoughtText = '';
    radioState.tickerText = '';
    broadcast({ type: 'state', payload: radioState });
    return res.json({ ok: true, empty: true });
  }
  const item = radioState.queue.shift();
  radioState.currentTrack = item;

  if (item.type === 'audio') {
    radioState.state = 'playing';
    radioState.tickerText = `▶ ${item.name} ◀ RADIO PS ▶ 99.9 FM ◀`;
    radioState.thoughtText = item.name;
  } else {
    radioState.state = 'text';
    radioState.thoughtText = item.text;
    radioState.tickerText = '';
  }
  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true, item });
});

// Стоп
app.post('/api/stop', authMiddleware, modOnly, (req, res) => {
  radioState.state = radioState.modOnline ? 'choosing' : 'offline';
  radioState.currentTrack = null;
  radioState.thoughtText = '';
  radioState.tickerText = '';
  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true });
});

// Удалить из очереди
app.delete('/api/queue/:id', authMiddleware, modOnly, (req, res) => {
  radioState.queue = radioState.queue.filter(i => i.id !== req.params.id);
  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true });
});

// Сигнал: трек кончился (от мод-клиента)
app.post('/api/track-ended', authMiddleware, modOnly, (req, res) => {
  // Автоперемотка на следующий
  if (radioState.queue.length > 0) {
    const item = radioState.queue.shift();
    radioState.currentTrack = item;
    if (item.type === 'audio') {
      radioState.state = 'playing';
      radioState.tickerText = `▶ ${item.name} ◀ RADIO PS ▶ 99.9 FM ◀`;
      radioState.thoughtText = item.name;
    } else {
      radioState.state = 'text';
      radioState.thoughtText = item.text;
      radioState.tickerText = '';
    }
  } else {
    radioState.state = 'choosing';
    radioState.currentTrack = null;
    radioState.thoughtText = '';
    radioState.tickerText = '';
  }
  broadcast({ type: 'state', payload: radioState });
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws, req) => {
  // Сразу отдаём текущее состояние новому клиенту
  ws.send(JSON.stringify({ type: 'state', payload: radioState }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Можно расширить протокол при необходимости
    } catch(e) {}
  });

  ws.on('close', () => {});
});

// ─── Очистка старых файлов (раз в час) ───────────────────────────────
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(UPLOADS_DIR).forEach(f => {
    const fp = path.join(UPLOADS_DIR, f);
    const stat = fs.statSync(fp);
    // Удаляем файлы старше 24 часов
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(fp);
    }
  });
}, 60 * 60 * 1000);

// ─── Запуск ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n📻 Radio PS запущен!`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n   MOD логин:  PS / faa`);
  console.log(`   Слушатель:  user / 1234\n`);
});
