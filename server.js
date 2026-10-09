// Volt & Conseil - serveur du chatbot (aucune dépendance à installer)
// La clé API reste ICI, sur le serveur. Elle ne doit jamais apparaître dans la page web.
const http = require('http');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const MODEL = 'claude-haiku-5-5';
const MAX_PER_IP_PER_HOUR = 20;
const MAX_PER_DAY = 500;

const CONTACT = 'WhatsApp +243 837 617 025 ou e-mail jeankaba148@gmail.com';
const BASE = `Tu es l'assistant de Volt & Conseil, un service de conseils et d'études en électricité tenu par un électrotechnicien.
Réponds en français, de façon claire, courte et professionnelle, sans jargon inutile. Domaines : tableau électrique, câbles et sections, disjoncteurs et différentiels, mise à la terre, protection contre les surtensions, éclairage, solaire et batteries, bornes de recharge, consommation, diagnostic de panne.
Sécurité : ne guide jamais un travail sous tension ni dans un tableau pour un particulier non qualifié. Pour toute intervention sur l'installation, recommande un électricien qualifié. En cas de danger (odeur de brûlé, étincelles, choc), dis de couper le courant général et d'appeler les secours. Si tu n'es pas sûr, dis-le. Ne présente jamais une norme étrangère comme une obligation légale locale.
Pour commander une offre : ${CONTACT}. N'invente aucun autre prix ni promesse.`;

const COUNTRIES = {
  RDC: { label: 'RD Congo', ctx: "Pays : République démocratique du Congo. Réseau 220 V monophasé / 380 V triphasé, 50 Hz, fournisseur SNEL, coupures et variations de tension fréquentes. Bonnes pratiques internationales (CEI 60364).", price: "consultation en ligne 30 min : 10 USD ; étude de projet écrite : à partir de 25 USD ; vérification de devis : 8 USD" },
  CI: { label: "Côte d'Ivoire", ctx: "Pays : Côte d'Ivoire. Réseau 230 V monophasé / 400 V triphasé, 50 Hz, fournisseur CIE. Bonnes pratiques internationales (CEI 60364).", price: "consultation en ligne 30 min : 6 000 FCFA ; étude de projet écrite : à partir de 15 000 FCFA ; vérification de devis : 5 000 FCFA" },
  CM: { label: 'Cameroun', ctx: "Pays : Cameroun. Réseau 230 V monophasé / 400 V triphasé, 50 Hz, fournisseur ENEO. Bonnes pratiques internationales (CEI 60364).", price: "consultation en ligne 30 min : 6 000 FCFA ; étude de projet écrite : à partir de 15 000 FCFA ; vérification de devis : 5 000 FCFA" },
  FR: { label: 'France', ctx: "Pays : France. Réseau 230 V, 50 Hz. Norme d'installation : NF C 15-100 ; attestation Consuel pour les installations neuves ou rénovées ; pour les bornes de recharge et le solaire, installateur qualifié (IRVE, RGE) requis.", price: "consultation en ligne 30 min : 15 EUR ; étude de projet écrite : à partir de 40 EUR ; vérification de devis : 12 EUR" },
  AUTRE: { label: 'Autre pays', ctx: "Pays : non précisé. Demande au client son pays si c'est important pour la réponse. Appuie-toi sur les bonnes pratiques internationales (CEI 60364) et précise que les règles locales peuvent différer.", price: "consultation en ligne 30 min : 15 EUR ; étude de projet écrite : à partir de 40 EUR ; vérification de devis : 12 EUR" }
};
function buildSystem(code) {
  const c = COUNTRIES[code] || COUNTRIES.AUTRE;
  return BASE + '\n' + c.ctx + '\nOffres payantes à proposer quand c\'est pertinent (' + c.price + ').';
}

const hits = new Map();
let day = new Date().toDateString(), dayCount = 0;
function limited(ip) {
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  if (++dayCount > MAX_PER_DAY) return true;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > MAX_PER_IP_PER_HOUR;
}

function clean(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages.slice(-10)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const text = m.content.slice(0, 1000).trim();
    if (!text) continue;
    if (out.length && out[out.length - 1].role === m.role) continue;
    out.push({ role: m.role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out.length && out[out.length - 1].role === 'user' ? out : null;
}

async function ask(messages, country) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: buildSystem(country), messages })
  });
  if (!r.ok) throw new Error('API ' + r.status);
  const d = await r.json();
  return d.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, html) => {
      if (e) { res.writeHead(500); return res.end('Erreur'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (limited(ip)) return send(res, 429, { error: 'Trop de demandes. Réessayez plus tard.' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const messages = clean(parsed.messages);
        const country = Object.prototype.hasOwnProperty.call(COUNTRIES, parsed.country) ? parsed.country : 'AUTRE';
        if (!messages) return send(res, 400, { error: 'Message invalide.' });
        send(res, 200, { text: await ask(messages, country) });
      } catch (e) {
        send(res, 500, { error: 'Réponse impossible pour le moment.' });
      }
    });
    return;
  }
  res.writeHead(404); res.end('Introuvable');
}).listen(PORT, () => console.log('Volt & Conseil sur le port ' + PORT));
