/**
 * WEBPANEL BACKEND — Node.js + Express
 * 
 * Ce serveur fait le pont entre le site web et Roblox via l'API Open Cloud.
 * 
 * INSTALLATION :
 *   npm install express cors jsonwebtoken bcryptjs dotenv axios ws
 *   node server.js
 * 
 * VARIABLES D'ENVIRONNEMENT (fichier .env) :
 *   PORT=3000
 *   JWT_SECRET=un_secret_long_et_random
 *   ROBLOX_API_KEY=votre_cle_open_cloud
 *   ROBLOX_UNIVERSE_ID=votre_universe_id
 *   PANEL_SECRET=CHANGEZ_MOI_SECRET_12345   ← même que dans le plugin Adonis
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const axios      = require('axios');
const { WebSocketServer } = require('ws');
const http       = require('http');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// ════════════════════════════════════════
//  CONFIGURATION
// ════════════════════════════════════════
const CONFIG = {
  PORT          : process.env.PORT           || 3000,
  JWT_SECRET    : process.env.JWT_SECRET     || 'change_this_jwt_secret',
  ROBLOX_KEY    : process.env.ROBLOX_API_KEY || '',
  UNIVERSE_ID   : process.env.ROBLOX_UNIVERSE_ID || '',
  PANEL_SECRET  : process.env.PANEL_SECRET   || 'CHANGEZ_MOI_SECRET_12345',
  TOKEN_EXPIRY  : '8h',
};

// ════════════════════════════════════════
//  BASE DE DONNÉES EN MÉMOIRE
//  (Remplacez par SQLite/MongoDB en prod !)
// ════════════════════════════════════════
const DB = {
  // Comptes du panel web. L'admin crée des comptes avec generatePassword()
  users: [
    // Exemple : admin créé au démarrage
    // { id: '1', robloxName: 'VotreNom', passwordHash: '...', role: 'owner', createdAt: Date.now() }
  ],

  // Logs reçus de Roblox
  logs: [],

  // Cache joueurs en ligne
  onlinePlayers: [],

  // Historique des commandes envoyées
  commandHistory: [],

  // Réponses en attente (requestId → resolver)
  pendingRequests: new Map(),
};

// ════════════════════════════════════════
//  MIDDLEWARES
// ════════════════════════════════════════
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  try {
    req.user = jwt.verify(header.slice(7), CONFIG.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }
    next();
  };
}

// ════════════════════════════════════════
//  UTILITAIRES
// ════════════════════════════════════════

function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from(crypto.randomBytes(length))
    .map(b => chars[b % chars.length])
    .join('');
}

function broadcastWS(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function addLog(log) {
  log.receivedAt = Date.now();
  DB.logs.unshift(log);
  if (DB.logs.length > 1000) DB.logs.pop();
  broadcastWS({ type: 'log', data: log });
}

// ════════════════════════════════════════
//  ROBLOX OPEN CLOUD API
// ════════════════════════════════════════

/**
 * Envoie un message au serveur Roblox via MessagingService (Open Cloud)
 */
async function sendToRoblox(command, args = [], caller = 'WebPanel') {
  const requestId = crypto.randomUUID();

  const payload = {
    secret   : CONFIG.PANEL_SECRET,
    command,
    args,
    caller,
    requestId,
    timestamp: Date.now(),
  };

  const url = `https://apis.roblox.com/messaging-service/v1/universes/${CONFIG.UNIVERSE_ID}/topics/WebPanel_Command`;

  try {
    await axios.post(url,
      { message: JSON.stringify(payload) },
      {
        headers: {
          'x-api-key'    : CONFIG.ROBLOX_KEY,
          'Content-Type' : 'application/json',
        },
      }
    );

    // Attendre la réponse du serveur Roblox (timeout 10s)
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        DB.pendingRequests.delete(requestId);
        resolve({ success: false, result: 'Timeout - le serveur Roblox n\'a pas répondu (10s)' });
      }, 10000);

      DB.pendingRequests.set(requestId, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    // Logguer la commande
    DB.commandHistory.unshift({
      command, args, caller,
      success : result.success,
      result  : result.result,
      at      : Date.now(),
    });
    if (DB.commandHistory.length > 500) DB.commandHistory.pop();

    return result;

  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error('[Roblox API]', errMsg);
    return { success: false, result: 'Erreur API Open Cloud: ' + errMsg };
  }
}

// ════════════════════════════════════════
//  WEBHOOK — Roblox → Backend
//  (Le plugin Roblox publie ses réponses,
//   le backend les reçoit via polling Open Cloud
//   ou via un webhook si configuré)
// ════════════════════════════════════════

// Polling des réponses Roblox (Subscribe n'est pas disponible côté Open Cloud,
// donc le plugin renvoie sur un endpoint HTTP configuré dans settings)
app.post('/webhook/roblox', (req, res) => {
  // Ce endpoint reçoit les messages que le plugin envoie via HttpService
  // (alternative au MessagingService Subscribe côté backend)
  const { secret, requestId, success, result, type, logs, players, gameJobId } = req.body;

  if (secret !== CONFIG.PANEL_SECRET) {
    return res.status(403).json({ error: 'Secret invalide' });
  }

  res.json({ ok: true });

  // Réponse à une commande
  if (requestId && DB.pendingRequests.has(requestId)) {
    const resolver = DB.pendingRequests.get(requestId);
    DB.pendingRequests.delete(requestId);
    resolver({ success, result });
  }

  // Push de logs
  if (type === 'log_push' && Array.isArray(logs)) {
    logs.forEach(addLog);
  }

  // Mise à jour des joueurs en ligne
  if (Array.isArray(players)) {
    DB.onlinePlayers = players;
    broadcastWS({ type: 'players', data: players });
  }
});

// ════════════════════════════════════════
//  ROUTES AUTH
// ════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { robloxName, password } = req.body;
  if (!robloxName || !password) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const user = DB.users.find(u => u.robloxName.toLowerCase() === robloxName.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign(
    { id: user.id, robloxName: user.robloxName, role: user.role },
    CONFIG.JWT_SECRET,
    { expiresIn: CONFIG.TOKEN_EXPIRY }
  );

  res.json({ token, user: { robloxName: user.robloxName, role: user.role } });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ════════════════════════════════════════
//  ROUTES ADMIN — Gestion des comptes
// ════════════════════════════════════════

// POST /api/admin/users — Créer un compte (owner seulement)
app.post('/api/admin/users', requireAuth, requireRole('owner'), async (req, res) => {
  const { robloxName, role = 'moderator' } = req.body;
  if (!robloxName) return res.status(400).json({ error: 'robloxName requis' });

  const existing = DB.users.find(u => u.robloxName.toLowerCase() === robloxName.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Utilisateur existe déjà' });

  const password     = generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const id           = crypto.randomUUID();

  DB.users.push({ id, robloxName, passwordHash, role, createdAt: Date.now() });

  res.json({ id, robloxName, role, password }); // Le mot de passe est retourné UNE SEULE FOIS
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAuth, requireRole('owner'), (req, res) => {
  const idx = DB.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Utilisateur introuvable' });
  DB.users.splice(idx, 1);
  res.json({ ok: true });
});

// GET /api/admin/users
app.get('/api/admin/users', requireAuth, requireRole('owner'), (req, res) => {
  res.json(DB.users.map(u => ({ id: u.id, robloxName: u.robloxName, role: u.role, createdAt: u.createdAt })));
});

// POST /api/admin/users/:id/reset-password
app.post('/api/admin/users/:id/reset-password', requireAuth, requireRole('owner'), async (req, res) => {
  const user = DB.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const password = generatePassword();
  user.passwordHash = await bcrypt.hash(password, 10);
  res.json({ password });
});

// ════════════════════════════════════════
//  ROUTES ROBLOX — Joueurs en ligne
// ════════════════════════════════════════

app.get('/api/roblox/players', requireAuth, (req, res) => {
  res.json(DB.onlinePlayers);
});

// ════════════════════════════════════════
//  ROUTES ROBLOX — Commandes
// ════════════════════════════════════════

// POST /api/roblox/kick
app.post('/api/roblox/kick', requireAuth, async (req, res) => {
  const { player, reason } = req.body;
  const result = await sendToRoblox('kick', [player, reason || 'Kicked via WebPanel'], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/ban
app.post('/api/roblox/ban', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { player, reason } = req.body;
  const result = await sendToRoblox('ban', [player, reason || 'Banned via WebPanel'], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/unban
app.post('/api/roblox/unban', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { player } = req.body;
  const result = await sendToRoblox('unban', [player], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/mute
app.post('/api/roblox/mute', requireAuth, async (req, res) => {
  const { player } = req.body;
  const result = await sendToRoblox('mute', [player], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/unmute
app.post('/api/roblox/unmute', requireAuth, async (req, res) => {
  const { player } = req.body;
  const result = await sendToRoblox('unmute', [player], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/announce
app.post('/api/roblox/announce', requireAuth, async (req, res) => {
  const { message } = req.body;
  const result = await sendToRoblox('announce', [message], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/shutdown
app.post('/api/roblox/shutdown', requireAuth, requireRole('owner'), async (req, res) => {
  const { reason } = req.body;
  const result = await sendToRoblox('shutdown', [reason || 'Shutdown via WebPanel'], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/setrank
app.post('/api/roblox/setrank', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const { player, rank } = req.body;
  const result = await sendToRoblox('setrank', [player, rank], req.user.robloxName);
  res.json(result);
});

// POST /api/roblox/raw
app.post('/api/roblox/raw', requireAuth, requireRole('owner'), async (req, res) => {
  const { command, args = [] } = req.body;
  const result = await sendToRoblox('raw', [command, ...args], req.user.robloxName);
  res.json(result);
});

// ════════════════════════════════════════
//  ROUTES LOGS
// ════════════════════════════════════════

app.get('/api/logs', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const type  = req.query.type;
  let logs    = DB.logs;
  if (type) logs = logs.filter(l => l.type === type);
  res.json(logs.slice(0, limit));
});

app.get('/api/logs/commands', requireAuth, (req, res) => {
  res.json(DB.commandHistory.slice(0, 100));
});

// ════════════════════════════════════════
//  WEBSOCKET — Push temps réel vers le panel
// ════════════════════════════════════════

wss.on('connection', (ws, req) => {
  // Auth via query param ?token=xxx
  const url    = new URL(req.url, 'http://localhost');
  const token  = url.searchParams.get('token');
  try {
    jwt.verify(token, CONFIG.JWT_SECRET);
  } catch {
    ws.close(1008, 'Non authentifié');
    return;
  }

  ws.send(JSON.stringify({
    type : 'init',
    data : {
      players : DB.onlinePlayers,
      logs    : DB.logs.slice(0, 50),
    }
  }));

  ws.on('error', console.error);
});

// ════════════════════════════════════════
//  INITIALISATION — Compte owner par défaut
// ════════════════════════════════════════

async function init() {
  if (DB.users.length === 0) {
    const password     = generatePassword(16);
    const passwordHash = await bcrypt.hash(password, 10);
    const ownerName    = process.env.OWNER_ROBLOX_NAME || 'Owner';

    DB.users.push({
      id          : crypto.randomUUID(),
      robloxName  : ownerName,
      passwordHash,
      role        : 'owner',
      createdAt   : Date.now(),
    });

    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        COMPTE OWNER CRÉÉ                 ║');
    console.log(`║  Pseudo Roblox : ${ownerName.padEnd(24)}║`);
    console.log(`║  Mot de passe  : ${password.padEnd(24)}║`);
    console.log('║  ⚠️  Notez ce mot de passe maintenant !  ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  }

  server.listen(CONFIG.PORT, () => {
    console.log(`✅ WebPanel Backend lancé sur http://localhost:${CONFIG.PORT}`);
    console.log(`   Universe ID  : ${CONFIG.UNIVERSE_ID || '⚠️  NON CONFIGURÉ'}`);
    console.log(`   Roblox Key   : ${CONFIG.ROBLOX_KEY ? '✅ Configurée' : '⚠️  NON CONFIGURÉE'}`);
  });
}

init().catch(console.error);
