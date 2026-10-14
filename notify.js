// Lancé chaque matin par GitHub Actions. Envoie des notifications push pour :
//  1. les abonnements clients qui finissent aujourd'hui ou demain (avec le profil)
//  2. les clients retirés automatiquement de leur profil (pas renouvelé depuis 1 jour)
//     + archivage automatique et silencieux des clients non renouvelés depuis 3 jours
//  3. tes propres comptes à renouveler (2 jours avant, puis chaque jour de retard)
const admin = require('firebase-admin');

const DAYS_TO_NOTIFY = [0, 1];   // 0 = aujourd'hui, 1 = demain. Ajoute 3 pour être prévenu 3 jours avant.
const FREE_AFTER_DAYS = 1;       // pas renouvelé depuis 1 jour : on le retire de son profil et on te prévient
const ARCHIVE_AFTER_DAYS = 3;    // pas renouvelé depuis 3 jours : archivé automatiquement, sans notification
const ACCOUNT_WARN_DAYS = 2;     // mes comptes : prévenir dès 2 jours avant la fin
const ACCOUNT_LATE_MAX = 10;     // puis chaque jour de retard, jusqu'à 10 jours
const TIMEZONE = 'Africa/Kinshasa';

// Page de paiement de chaque service (un lien personnalisé enregistré dans « Mes comptes » est prioritaire)
const PAY_URLS = {
  netflix: 'https://www.netflix.com/youraccount',
  prime: 'https://www.primevideo.com/settings',
  crunchyroll: 'https://www.crunchyroll.com/account/membership'
};

const LABEL = { netflix: 'Netflix', prime: 'Prime Video', crunchyroll: 'Crunchyroll', combo: 'Combo Netflix + Prime' };
const SHORT = { netflix: 'Netflix', prime: 'Prime Video', crunchyroll: 'Crunchyroll' };
const PREFIX = { netflix: 'Vision', prime: 'Prime', crunchyroll: 'OTW' };

const toUTC = (s) => Date.parse(s + 'T00:00:00Z');
const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

let tokens = [];
let db;
const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

async function send(data) {
  if (!tokens.length) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: [...tokens],
    data,
    webpush: { headers: { TTL: '43200', Urgency: 'high' } }
  });
  console.log(`« ${data.title} » : ${res.successCount} ok, ${res.failureCount} échec(s).`);
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
  });
  if (dead.length) {
    tokens = tokens.filter((t) => !dead.includes(t));
    await db.doc('settings/push').update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) });
  }
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('Secret FIREBASE_SERVICE_ACCOUNT manquant.'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  db = admin.firestore();
  const appUrl = process.env.APP_URL || '';
  const today = todayStr();

  const pushDoc = await db.doc('settings/push').get();
  tokens = (pushDoc.exists && pushDoc.data().tokens) || [];
  if (!tokens.length) console.log('Aucun appareil enregistré pour les notifications (le ménage des profils est fait quand même).');

  const names = ((await db.doc('settings/profiles').get()).data() || {}).names || {};
  const profName = (id) => names[id] || `${PREFIX[id.split('-')[0]]} ${id.split('-')[1]}`;
  const profParts = (s) => Object.entries(s.profiles || {}).filter(([, id]) => id).map(([svc, id]) => `${profName(id)} (${SHORT[svc]})`);

  const subs = (await db.collection('subscriptions').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const pending = subs.filter((s) => {
    if (s.archived || !s.endDate) return false;
    const renewed = subs.some((o) => o.id !== s.id && o.clientId === s.clientId && o.service === s.service && o.endDate > s.endDate);
    return !renewed;
  });

  // 0. Ménage automatique : retire du profil (J+1) et archive (J+3) les clients qui n'ont pas renouvelé
  const freedNow = [], updates = [];
  for (const s of pending) {
    const left = diffDays(today, s.endDate);
    const parts = profParts(s);
    const arch = left <= -ARCHIVE_AFTER_DAYS, free = left <= -FREE_AFTER_DAYS && parts.length > 0;
    if (!arch && !free) continue;
    const upd = {};
    if (parts.length) { freedNow.push(`${s.clientName} retiré de ${parts.join(' + ')}`); upd.profiles = {}; upd.freedProfiles = { ...s.profiles }; upd.freedAt = today; }
    if (arch) { upd.archived = true; upd.archivedAt = today; }
    updates.push([s.id, upd]);
  }
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch();
    updates.slice(i, i + 400).forEach(([id, upd]) => batch.update(db.collection('subscriptions').doc(id), upd));
    await batch.commit();
  }
  if (updates.length) console.log(`Ménage : ${updates.length} abonnement(s) mis à jour, ${freedNow.length} profil(s) libéré(s).`);

  // 1. Abonnements clients qui finissent aujourd'hui ou demain
  for (const d of DAYS_TO_NOTIFY) {
    const group = pending.filter((s) => diffDays(today, s.endDate) === d);
    if (!group.length) continue;
    const when = d === 0 ? "aujourd'hui" : d === 1 ? 'demain' : `dans ${d} jours`;
    const n = group.length;
    const body = group.map((s) => {
      const p = profParts(s).join(' + ');
      return `${s.clientName} (${LABEL[s.service] || s.service}${p ? ', ' + p : ''})`;
    }).join(', ');
    await send({
      title: `⏰ ${n} abonnement${n > 1 ? 's' : ''} fini${n > 1 ? 'ssent' : 't'} ${when}`,
      body: cut(body, 180), url: appUrl + '?filter=soon', tag: `fin-${d}`
    });
  }

  // 2. Places libérées (clients retirés de leur profil)
  if (freedNow.length) {
    const n = freedNow.length;
    await send({
      title: `🔓 ${n} place${n > 1 ? 's' : ''} libérée${n > 1 ? 's' : ''}`,
      body: cut(freedNow.join('; '), 180), url: appUrl + '?tab=profiles', tag: 'liberer'
    });
  }

  // 3. Mes propres comptes à renouveler
  const accounts = (await db.collection('accounts').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const due = accounts
    .filter((a) => a.endDate)
    .map((a) => ({ a, d: diffDays(today, a.endDate) }))
    .filter(({ d }) => d <= ACCOUNT_WARN_DAYS && d >= -ACCOUNT_LATE_MAX)
    .sort((x, y) => x.d - y.d);
  // Une notification par compte : un tap ouvre directement la page de paiement
  for (const { a, d } of due) {
    const quand = d < 0 ? (d === -1 ? 'a expiré hier' : `est en retard de ${-d} jours`) : d === 0 ? "se renouvelle aujourd'hui" : d === 1 ? 'se renouvelle demain' : `se renouvelle dans ${d} jours`;
    await send({
      title: `💳 ${a.name} ${quand}`,
      body: `Fin le ${a.endDate}. Touche pour payer.`,
      url: a.payUrl || PAY_URLS[a.service] || (appUrl + '?tab=accounts'),
      tag: 'compte-' + a.id
    });
  }

  if (!subs.length && !accounts.length) console.log(`${today} : rien à signaler.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
