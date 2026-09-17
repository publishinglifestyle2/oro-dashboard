import { NextRequest, NextResponse } from "next/server";
import { assicuraSchema, getSql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let schemaPronto = false;

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

  return NextResponse.json({ ok: true });
}

// utile per verificare rapidamente dal browser che l'endpoint sia raggiungibile (senza scrivere nulla)
export async function GET() {
  return NextResponse.json({ ok: true, info: "invia una POST con ?key=... per registrare una candela" });
}
