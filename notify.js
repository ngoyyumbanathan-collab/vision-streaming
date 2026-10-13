// Lancé chaque matin par GitHub Actions : envoie une notification push
// pour les abonnements qui finissent aujourd'hui ou demain.
const admin = require('firebase-admin');

const DAYS_TO_NOTIFY = [0, 1]; // 0 = aujourd'hui, 1 = demain. Ajoute 3 pour être prévenu 3 jours avant.
const TIMEZONE = 'Africa/Kinshasa';
const LABEL = { netflix: 'Netflix', prime: 'Prime Video', crunchyroll: 'Crunchyroll', combo: 'Combo Netflix + Prime' };

const toUTC = (s) => Date.parse(s + 'T00:00:00Z');
const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('Secret FIREBASE_SERVICE_ACCOUNT manquant.'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  const appUrl = process.env.APP_URL || '';
  const today = todayStr();

  const subs = (await db.collection('subscriptions').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

  // On ignore les abonnements archivés et ceux déjà renouvelés
  const due = subs.filter((s) => {
    if (s.archived || !s.endDate) return false;
    if (!DAYS_TO_NOTIFY.includes(diffDays(today, s.endDate))) return false;
    const renewed = subs.some((o) => o.id !== s.id && o.clientId === s.clientId && o.service === s.service && o.endDate > s.endDate);
    return !renewed;
  });

  if (!due.length) { console.log(`${today} : rien à signaler.`); return; }

  const pushDoc = await db.doc('settings/push').get();
  const tokens = (pushDoc.exists && pushDoc.data().tokens) || [];
  if (!tokens.length) { console.log('Aucun appareil enregistré pour les notifications.'); return; }

  for (const d of DAYS_TO_NOTIFY) {
    const group = due.filter((s) => diffDays(today, s.endDate) === d);
    if (!group.length) continue;
    const when = d === 0 ? "aujourd'hui" : d === 1 ? 'demain' : `dans ${d} jours`;
    const n = group.length;
    let body = group.map((s) => `${s.clientName} (${LABEL[s.service] || s.service})`).join(', ');
    if (body.length > 180) body = body.slice(0, 177) + '…';

    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        title: `⏰ ${n} abonnement${n > 1 ? 's' : ''} fini${n > 1 ? 'ssent' : 't'} ${when}`,
        body,
        url: appUrl + '?filter=soon',
        tag: `fin-${d}`
      },
      webpush: { headers: { TTL: '43200', Urgency: 'high' } }
    });
    console.log(`Envoyé (${when}) : ${res.successCount} ok, ${res.failureCount} échec(s).`);

    // Nettoyage des appareils qui ne reçoivent plus
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
    });
    if (dead.length) await db.doc('settings/push').update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
