// notifiche push vere (arrivano anche a telefono bloccato/app chiusa), via web push standard —
// nessun servizio esterno tipo firebase: solo le chiavi VAPID e il browser del telefono.
import webpush from "web-push";
import { getSql } from "./db";

let vapidConfigurato = false;

function assicuraVapid() {
  if (vapidConfigurato) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non impostate");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:info@example.com", pub, priv);
  vapidConfigurato = true;
}

export interface AbbonamentoPush {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function salvaAbbonamento(sub: AbbonamentoPush): Promise<void> {
  const sql = getSql();
  await sql`
    insert into abbonamenti_push (endpoint, p256dh, auth)
    values (${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
    on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth
  `;
}

export async function rimuoviAbbonamento(endpoint: string): Promise<void> {
  const sql = getSql();
  await sql`delete from abbonamenti_push where endpoint = ${endpoint}`;
}

/** manda la notifica a tutti i telefoni/browser abbonati. rimuove da solo gli abbonamenti
 * scaduti (410/404 — l'utente ha disinstallato o disattivato le notifiche). */
export async function inviaATutti(titolo: string, corpo: string, dati?: Record<string, unknown>): Promise<number> {
  assicuraVapid();
  const sql = getSql();
  const righe = (await sql`select endpoint, p256dh, auth from abbonamenti_push`) as {
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];
  const payload = JSON.stringify({ title: titolo, body: corpo, data: dati || {} });
  let inviate = 0;
  await Promise.all(
    righe.map(async (r) => {
      try {
        await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
        inviate++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await rimuoviAbbonamento(r.endpoint);
      }
    })
  );
  return inviate;
}

/** manda la notifica solo se la "chiave" (es. lato+entrata+candela) è diversa dall'ultima già
 * inviata — evita di far vibrare il telefono a ogni candela finché il segnale resta lo stesso. */
export async function inviaSeNuovo(chiave: string, titolo: string, corpo: string, dati?: Record<string, unknown>): Promise<boolean> {
  const sql = getSql();
  const righe = (await sql`select ultima_chiave from push_stato where id = 1`) as { ultima_chiave: string | null }[];
  if (righe[0]?.ultima_chiave === chiave) return false;
  await sql`update push_stato set ultima_chiave = ${chiave} where id = 1`;
  await inviaATutti(titolo, corpo, dati);
  return true;
}

/** come inviaSeNuovo, ma su un canale indipendente (vedi push_canali in lib/db.ts): usata per il
 * promemoria "guarda il grafico" (setup "slancio", vedi motore.ts), che deve deduplicare per
 * conto suo senza interferire con la deduplica del vero segnale di trade. */
export async function inviaSeNuovoSuCanale(
  canale: string,
  chiave: string,
  titolo: string,
  corpo: string,
  dati?: Record<string, unknown>
): Promise<boolean> {
  const sql = getSql();
  const righe = (await sql`select ultima_chiave from push_canali where canale = ${canale}`) as { ultima_chiave: string | null }[];
  if (righe[0]?.ultima_chiave === chiave) return false;
  await sql`
    insert into push_canali (canale, ultima_chiave) values (${canale}, ${chiave})
    on conflict (canale) do update set ultima_chiave = excluded.ultima_chiave
  `;
  await inviaATutti(titolo, corpo, dati);
  return true;
}
