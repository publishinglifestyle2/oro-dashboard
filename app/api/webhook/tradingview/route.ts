import { NextRequest, NextResponse } from "next/server";
import { assicuraSchema, assicuraSchemaPush, getSql } from "@/lib/db";
import { fetchDbTutto } from "@/lib/tvdb";
import { costruisciQuadro, costruisciScenari, valutaTrigger, rr, RR_MINIMO_T2 } from "@/lib/motore";
import { inviaSeNuovo } from "@/lib/push";
import { formattaUsd } from "@/lib/candele";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let schemaPronto = false;
let schemaPushPronto = false;

/** dopo ogni candela ricontrolla il segnale, e se è un nuovo BUY/SELL manda la notifica push.
 * gira solo se la candela chiude un blocco di 5 minuti — stessa cadenza del motore. */
async function controllaEAvvisa(t: number) {
  if (Math.floor(t / 60_000) % 5 !== 4) return;
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
  if (segnale.lato === "ATTENDI" || !segnale.scenario) return;
  const s = segnale.scenario;
  if (rr(s, s.t2) < RR_MINIMO_T2) return;

  if (!schemaPushPronto) {
    await assicuraSchemaPush();
    schemaPushPronto = true;
  }
  const chiave = `${segnale.lato}-${s.entrata}-${quadro.t}`;
  const icona = segnale.lato === "BUY" ? "🟢" : "🔴";
  await inviaSeNuovo(
    chiave,
    `${icona} XAUUSD ${segnale.lato}`,
    `entrata ${formattaUsd(s.entrata, 2)} · stop ${formattaUsd(s.stop, 2)} · target ${formattaUsd(s.t1, 2)} / ${formattaUsd(s.t2, 2)}`
  );
}

// TradingView chiama questo indirizzo a ogni chiusura di candela 1 minuto (vedi il Pine Script).
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
      schemaPronto = true;
    }
    const sql = getSql();
    await sql`
      insert into candele_1m (t, open, high, low, close, volume)
      values (${t as number}, ${open as number}, ${high as number}, ${low as number}, ${close as number}, ${volume})
      on conflict (t) do update set
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
    `;
  } catch (e) {
    const messaggio = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, errore: `database: ${messaggio}` }, { status: 500 });
  }

  // la candela è già salvata: un problema qui (push non configurata, rete, ecc.) non deve
  // far fallire la risposta a TradingView, altrimenti riprova e si perde comunque il dato.
  try {
    await controllaEAvvisa(t as number);
  } catch (e) {
    console.error("controllo segnale/push fallito:", e);
  }

  return NextResponse.json({ ok: true });
}

// utile per verificare rapidamente dal browser che l'endpoint sia raggiungibile (senza scrivere nulla)
export async function GET() {
  return NextResponse.json({ ok: true, info: "invia una POST con ?key=... per registrare una candela" });
}
