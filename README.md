# WebPanel — Adonis Admin Interface

Panel web pour gérer votre jeu Roblox via Adonis, accessible depuis un navigateur.

---

## Architecture

```
Navigateur (panel web)
        ↕  API REST + WebSocket
Backend Node.js (server.js)
        ↕  Roblox Open Cloud API (MessagingService)
Plugin Adonis (Server:WebPanel)
        ↕  DataStore Roblox
```

---

## Installation

### Étape 1 — Créer une clé API Roblox Open Cloud

1. Allez sur https://create.roblox.com/credentials
2. Cliquez **Create API Key**
3. Donnez un nom (ex: "WebPanel")
4. Sous **Access Permissions** → **Universe Messaging Service** → ajoutez votre expérience
5. Cochez **Write** (publish)
6. **Generate Key** → copiez la clé

Notez aussi votre **Universe ID** (dans l'URL de votre jeu sur Roblox : `roblox.com/games/XXXXXXXXX`)

---

### Étape 2 — Installer le plugin Adonis

1. Dans Roblox Studio, ouvrez votre modèle Adonis
2. Allez dans **Config → Plugins**
3. Créez un nouveau **ModuleScript** nommé `Server:WebPanel`
4. Collez le contenu de `adonis-plugin-server.lua`
5. **Important** : changez `CONFIG.SECRET_KEY` dans le script pour une clé secrète de votre choix

---

### Étape 3 — Configurer le backend Node.js

```bash
# Cloner / copier les fichiers server.js, package.json, .env.example
npm install
cp .env.example .env
```

Éditez `.env` :
```
PORT=3000
JWT_SECRET=une_longue_chaine_aleatoire_ici
ROBLOX_API_KEY=votre_cle_open_cloud
ROBLOX_UNIVERSE_ID=votre_universe_id
PANEL_SECRET=MÊME_VALEUR_QUE_DANS_LE_PLUGIN
OWNER_ROBLOX_NAME=VotrePseudoRoblox
```

⚠️ `PANEL_SECRET` doit être **identique** à `CONFIG.SECRET_KEY` dans le plugin Adonis !

---

### Étape 4 — Configurer le Webhook (réception des réponses Roblox)

Le plugin Adonis doit pouvoir envoyer des réponses au backend.

**Option A — Ngrok (développement local) :**
```bash
ngrok http 3000
# Copiez l'URL https://xxxxx.ngrok.io
```

Dans le plugin Adonis (`adonis-plugin-server.lua`), cherchez la section webhook et mettez votre URL ngrok.

**Option B — Serveur avec IP publique (production) :**
Hébergez `server.js` sur Railway, Render, VPS, etc. et utilisez l'URL publique.

L'endpoint webhook du backend est : `POST /webhook/roblox`

---

### Étape 5 — Lancer le backend

```bash
npm start
```

Au premier démarrage, le mot de passe du compte owner s'affiche dans la console :
```
╔══════════════════════════════════════════╗
║        COMPTE OWNER CRÉÉ                 ║
║  Pseudo Roblox : VotrePseudo             ║
║  Mot de passe  : xK9mP2nQ8rT6vZ4w       ║
╚══════════════════════════════════════════╝
```

**Notez ce mot de passe !** Il ne sera plus affiché.

---

### Étape 6 — Ouvrir le panel

Ouvrez `http://localhost:3000` dans votre navigateur (ou l'URL de votre serveur).

Connectez-vous avec votre pseudo Roblox et le mot de passe généré.

---

## Fonctionnalités

| Fonctionnalité | Mod | Admin | Owner |
|---|---|---|---|
| Voir les joueurs | ✅ | ✅ | ✅ |
| Kick | ✅ | ✅ | ✅ |
| Mute/Unmute | ✅ | ✅ | ✅ |
| Ban/Unban | ❌ | ✅ | ✅ |
| Changer les rangs | ❌ | ✅ | ✅ |
| Annonces | ✅ | ✅ | ✅ |
| Voir les logs | ✅ | ✅ | ✅ |
| Shutdown | ❌ | ❌ | ✅ |
| Console RAW | ❌ | ❌ | ✅ |
| Gérer les comptes | ❌ | ❌ | ✅ |

---

## Hébergement

### Railway (recommandé, gratuit)
```bash
# Installez la CLI Railway
npm install -g @railway/cli
railway login
railway init
railway up
```

Ajoutez vos variables d'environnement dans le dashboard Railway.

### Render
1. Créez un compte sur render.com
2. New → Web Service → connectez votre repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Ajoutez les env variables

---

## Sécurité

- Ne partagez jamais `.env` ni les tokens
- Changez `PANEL_SECRET` et `JWT_SECRET` pour des valeurs aléatoires longues
- En production, utilisez HTTPS
- La clé API Roblox ne doit avoir que les permissions nécessaires (write messaging uniquement)

---

## Structure des fichiers

```
webpanel/
├── server.js                 ← Backend Node.js
├── package.json
├── .env.example              ← Template de configuration
├── public/
│   └── index.html            ← Interface web (panel admin)
└── roblox/
    ├── adonis-plugin-server.lua  ← Plugin Adonis (Server:WebPanel)
    └── client-webpanel.lua       ← Plugin client optionnel (Client:WebPanel)
```
