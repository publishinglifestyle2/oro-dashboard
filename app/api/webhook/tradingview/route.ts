import { NextRequest, NextResponse } from "next/server";
import { assicuraSchema, assicuraSchemaAggregati, assicuraSchemaPush, getSql } from "@/lib/db";
import { fetchDbTutto } from "@/lib/tvdb";
import { costruisciQuadro, costruisciScenari, valutaTrigger, rr, RR_MINIMO_T2, rilevaSlancio } from "@/lib/motore";
import { inviaSeNuovo, inviaSeNuovoSuCanale } from "@/lib/push";
import { formattaUsd } from "@/lib/candele";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let schemaPronto = false;
let schemaPushPronto = false;

/** dopo ogni candela ricontrolla il segnale, e se è un nuovo BUY/SELL manda la notifica push.
 * il motore decide comunque solo su chiusure 5m (ricampionate dalla fonte 1m, vedi lib/tvdb.ts):
 * arrivare ogni minuto invece che ogni 5 non cambia le decisioni, solo quanto in fretta le vede. */
async function controllaEAvvisa() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return; // push non configurata: salta senza errori

  const dati = await fetchDbTutto();
  if (!dati) return;
  const { h1, m15, m5 } = dati;
  if (m5.length < 40 || m15.length < 40 || h1.length < 40) return;

  const oraInizio = parseFloat(process.env.ORA_INIZIO || "0");
  const oraFine = parseFloat(process.env.ORA_FINE || "24");
  const quadro = costruisciQuadro(h1, m15, m5);
  const scenari = costruisciScenari(quadro);
  const segnale = valutaTrigger(m5, quadro, scenari, oraInizio, oraFine);

  if (!schemaPushPronto) {
    await assicuraSchemaPush();
    schemaPushPronto = true;
  }

  // segnale vero (solo "rimbalzo", vedi SETUP_ATTIVI in motore.ts): entrata/stop/target precisi,
  // pensati per essere seguiti così come sono.
  if (segnale.lato !== "ATTENDI" && segnale.scenario && rr(segnale.scenario, segnale.scenario.t2) >= RR_MINIMO_T2) {
    const s = segnale.scenario;
    // arrotondato a 4$ e SENZA l'orario candela: così un segnale che resta valido per più candele
    // di fila non manda una notifica ogni 5 minuti, ma solo quando cambia lato/setup o il prezzo
    // si è mosso abbastanza da essere un aggiornamento vero.
    const chiave = `${segnale.lato}-${s.nome}-${Math.round(s.entrata / 4) * 4}`;
    const icona = segnale.lato === "BUY" ? "🟢" : "🔴";
    await inviaSeNuovo(
      chiave,
      `${icona} XAUUSD ${segnale.lato}`,
      `entrata ${formattaUsd(s.entrata, 2)} · stop ${formattaUsd(s.stop, 2)} · target ${formattaUsd(s.t1, 2)} / ${formattaUsd(s.t2, 2)}`
    );
  }

  // promemoria "guarda il grafico": setup "slancio", tolto da SETUP_ATTIVI perché sui dati non
  // è un trade da seguire alla lettera (vedi motore.ts), ma resta un indicatore utile di "sta
  // succedendo qualcosa" — canale indipendente, niente entrata/stop/target promessi come precisi.
  const concluse = m5.filter((c) => c.completa);
  const spinta = rilevaSlancio(concluse, quadro.atr5);
  if (spinta) {
    const icona = spinta.lato === "BUY" ? "👀🟢" : "👀🔴";
    const chiaveWatch = `${spinta.lato}-${Math.round(quadro.prezzo / 4) * 4}`;
    await inviaSeNuovoSuCanale(
      "watch",
      chiaveWatch,
      `${icona} XAUUSD in movimento`,
      `spinta ${spinta.lato} in corso, prezzo ~${formattaUsd(quadro.prezzo, 2)} — dai un'occhiata al grafico, valuta tu (non è un'entrata precisa)`
    );
  }
}

/** ricalcola una candela aggregata (15m o 1h) dai minuti grezzi già salvati in quella finestra e
 * la scrive con un upsert — vedi la nota sopra sul perché rileggere (poche righe, indicizzate)
 * invece di sommare in incrementale. sql.query() serve solo perché il nome tabella non si può
 * parametrizzare in un tagged template: i due valori possibili sono letterali qui sotto, mai
 * input esterno. */
async function aggiornaAggregato(
  sql: ReturnType<typeof getSql>,
  tabella: "candele_15m_agg" | "candele_1h_agg",
  inizio: number,
  fine: number
) {
  const righe = (await sql.query(
    `select open, high, low, close, volume from candele_1m where t >= $1 and t < $2 order by t asc`,
    [inizio, fine]
  )) as { open: number; high: number; low: number; close: number; volume: number }[];
  if (!righe.length) return;
  const open = righe[0].open;
  const close = righe[righe.length - 1].close;
  const high = Math.max(...righe.map((r) => r.high));
  const low = Math.min(...righe.map((r) => r.low));
  const volume = righe.reduce((s, r) => s + r.volume, 0);
  await sql.query(
    `insert into ${tabella} (t, open, high, low, close, volume)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (t) do update set
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume`,
    [inizio, open, high, low, close, volume]
  );
}

// TradingView chiama questo indirizzo a ogni chiusura di candela 1 minuto (luca-oro-feed-1m.pine).
// La chiave nell'url protegge l'endpoint: senza TV_WEBHOOK_SECRET configurata, rifiuta tutto.
export async function POST(req: NextRequest) {
  const chiave = req.nextUrl.searchParams.get("key");
  const attesa = process.env.TV_WEBHOOK_SECRET?.trim();
  if (!attesa || chiave !== attesa) {
    return NextResponse.json({ ok: false, errore: "chiave non valida" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, errore: "corpo non valido, atteso json" }, { status: 400 });
  }

  const p = payload as Record<string, unknown>;
  const { t, open, high, low, close } = p;
  const volume = typeof p.volume === "number" ? p.volume : 0;
  if (![t, open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return NextResponse.json({ ok: false, errore: "campi mancanti o non numerici (t, open, high, low, close)" }, { status: 400 });
  }

  try {
    if (!schemaPronto) {
      await assicuraSchema();
      await assicuraSchemaAggregati();
      schemaPronto = true;
    }
    const sql = getSql();
    const tn = t as number;
    await sql`
      insert into candele_1m (t, open, high, low, close, volume)
      values (${tn}, ${open as number}, ${high as number}, ${low as number}, ${close as number}, ${volume})
      on conflict (t) do update set
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
    `;
    // ricalcola le due candele aggregate (15m/1h) del minuto appena arrivato RILEGGENDO solo i
    // minuti di quel bucket (al massimo 15 o 60 righe, mai lo storico) invece di sommare in
    // incrementale: così un webhook rimandato due volte per lo stesso minuto (retry di rete) non
    // duplica il volume nell'aggregato — resta sempre coerente col dato grezzo, che è la verità.
    const bucket15 = Math.floor(tn / 900_000) * 900_000;
    const bucket1h = Math.floor(tn / 3_600_000) * 3_600_000;
    await Promise.all([
      aggiornaAggregato(sql, "candele_15m_agg", bucket15, bucket15 + 900_000),
      aggiornaAggregato(sql, "candele_1h_agg", bucket1h, bucket1h + 3_600_000),
    ]);
  } catch (e) {
    const messaggio = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, errore: `database: ${messaggio}` }, { status: 500 });
  }

  // la candela è già salvata: un problema qui (push non configurata, rete, ecc.) non deve
  // far fallire la risposta a TradingView, altrimenti riprova e si perde comunque il dato.
  try {
    await controllaEAvvisa();
  } catch (e) {
    console.error("controllo segnale/push fallito:", e);
  }

  return NextResponse.json({ ok: true });
}

// utile per verificare rapidamente dal browser che l'endpoint sia raggiungibile (senza scrivere nulla)
export async function GET() {
  return NextResponse.json({ ok: true, info: "invia una POST con ?key=... per registrare una candela" });
}
