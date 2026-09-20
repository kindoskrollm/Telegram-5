/**
 * tg-client — свой минимальный веб-клиент Telegram.
 *
 * Идея: вся реальная работа с Telegram (MTProto) происходит здесь,
 * на сервере (Render), через библиотеку GramJS — используя ТВОЙ
 * личный аккаунт (логин по номеру телефона, как в обычном Telegram).
 * Браузер общается только с этим сервером по HTTPS/WebSocket —
 * к доменам telegram.org он вообще не обращается, поэтому DPI по
 * доменам/сигнатурам Telegram тут ни при чём.
 *
 * Нужно (переменные окружения на Render):
 *   TG_API_ID    — с https://my.telegram.org (API development tools)
 *   TG_API_HASH  — оттуда же
 *   TG_SESSION   — пусто при первом запуске; после первого логина
 *                  сервер выведет строку сессии в логи — её нужно
 *                  скопировать и вписать в этот env var, чтобы не
 *                  логиниться заново при каждом рестарте.
 *
 * ⚠️ Строка сессии (TG_SESSION) даёт полный доступ к твоему аккаунту.
 * Никогда не публикуй её и не коммить в git.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const apiId = parseInt(process.env.TG_API_ID || '0', 10);
const apiHash = process.env.TG_API_HASH || '';
const initialSession = process.env.TG_SESSION || '';

if (!apiId || !apiHash) {
  console.error('Не заданы TG_API_ID / TG_API_HASH — сервер не сможет подключиться к Telegram.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: '/tmp/uploads' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let client = null;
let isReady = false;
const pending = {}; // deferred-промисы для шагов логина

function waitFor(key) {
  return new Promise((resolve) => {
    pending[key] = resolve;
  });
}
function resolvePending(key, value) {
  if (pending[key]) {
    pending[key](value);
    delete pending[key];
  }
}

async function serializeMessage(msg) {
  let mediaType = null;
  if (msg.photo) mediaType = 'photo';
  else if (msg.document) mediaType = 'document';
  return {
    id: msg.id,
    chatId: msg.chatId ? msg.chatId.toString() : null,
    out: !!msg.out,
    date: msg.date,
    text: msg.message || '',
    mediaType,
    senderId: msg.senderId ? msg.senderId.toString() : null,
  };
}

function attachHandlers() {
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      io.emit('message', await serializeMessage(msg));
    } catch (e) {
      console.error('handler error', e);
    }
  }, new NewMessage({}));
}

async function initClient() {
  const session = new StringSession(initialSession);
  client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  isReady = await client.checkAuthorization();
  if (isReady) {
    console.log('Сессия восстановлена, авторизация не требуется.');
    attachHandlers();
  } else {
    console.log('Нужна авторизация — открой сайт и залогинься через форму.');
  }
}

initClient().catch((e) => console.error('init error', e));

// ---------------- ЛОГИН ----------------

app.get('/api/status', (req, res) => {
  res.json({ ready: isReady });
});

app.post('/api/login/start', (req, res) => {
  if (isReady) return res.json({ ok: true, already: true });
  res.json({ ok: true });
  runLogin();
});

async function runLogin() {
  try {
    await client.start({
      phoneNumber: async () => {
        io.emit('login-step', { step: 'phone' });
        return waitFor('phone');
      },
      phoneCode: async () => {
        io.emit('login-step', { step: 'code' });
        return waitFor('code');
      },
      password: async () => {
        io.emit('login-step', { step: 'password' });
        return waitFor('password');
      },
      onError: (err) => {
        console.error('login error', err);
        io.emit('login-error', { error: err.message });
      },
    });
    isReady = true;
    const savedSession = client.session.save();
    console.log('=========================================');
    console.log('УСПЕШНЫЙ ЛОГИН. Сохрани эту строку в Render → Environment → TG_SESSION:');
    console.log(savedSession);
    console.log('=========================================');
    io.emit('login-done', {});
    attachHandlers();
  } catch (e) {
    console.error('runLogin failed', e);
    io.emit('login-error', { error: e.message });
  }
}

app.post('/api/login/submit', (req, res) => {
  const { step, value } = req.body;
  resolvePending(step, value);
  res.json({ ok: true });
});

// ---------------- ЧАТЫ / СООБЩЕНИЯ ----------------

function requireReady(req, res, next) {
  if (!isReady) return res.status(401).json({ error: 'not authorized' });
  next();
}

app.get('/api/dialogs', requireReady, async (req, res) => {
  try {
    const dialogs = await client.getDialogs({ limit: 50 });
    res.json(
      dialogs.map((d) => ({
        id: d.id ? d.id.toString() : null,
        name: d.title || d.name || '(без имени)',
        unreadCount: d.unreadCount || 0,
        lastMessage: d.message ? d.message.message : '',
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages/:chatId', requireReady, async (req, res) => {
  try {
    const messages = await client.getMessages(req.params.chatId, { limit: 50 });
    const out = await Promise.all(messages.reverse().map(serializeMessage));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send', requireReady, upload.single('file'), async (req, res) => {
  try {
    const { chatId, text } = req.body;
    if (req.file) {
      await client.sendFile(chatId, { file: req.file.path, caption: text || '' });
    } else {
      await client.sendMessage(chatId, { message: text || '' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/media/:chatId/:msgId', requireReady, async (req, res) => {
  try {
    const msgs = await client.getMessages(req.params.chatId, {
      ids: [parseInt(req.params.msgId, 10)],
    });
    const msg = msgs[0];
    if (!msg || (!msg.photo && !msg.document)) return res.status(404).end();
    const buffer = await client.downloadMedia(msg, {});
    res.set('Content-Type', msg.photo ? 'image/jpeg' : 'application/octet-stream');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`tg-client listening on ${PORT}`));
