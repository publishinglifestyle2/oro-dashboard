import { NextResponse } from "next/server";
import { assicuraSchemaOperazioni } from "@/lib/db";
import { apriOperazione, chiudiOperazione, modificaOperazione, operazioneAperta, storicoOperazioni } from "@/lib/operazioni";
import { calcolaSize } from "@/lib/motore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let schemaPronto = false;
async function assicura() {
  if (!schemaPronto) {
    await assicuraSchemaOperazioni();
    schemaPronto = true;
  }
}

export async function GET() {
  try {
    await assicura();
    const [aperta, storico] = await Promise.all([operazioneAperta(), storicoOperazioni()]);
    return NextResponse.json({ ok: true, aperta, storico });
  } catch (e) {
    return NextResponse.json({ ok: false, errore: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await assicura();
    const body = await req.json();

    if (body.azione === "apri") {
      const { lato, entrata, stop, t1, t2, motivo, apertaIl } = body;
      if (!["BUY", "SELL"].includes(lato) || ![entrata, stop, t1, t2].every((v) => typeof v === "number" && Number.isFinite(v))) {
        return NextResponse.json({ ok: false, errore: "dati mancanti o non validi" }, { status: 400 });
      }
      if (apertaIl !== undefined && (typeof apertaIl !== "string" || Number.isNaN(Date.parse(apertaIl)))) {
        return NextResponse.json({ ok: false, errore: "orario di entrata non valido" }, { status: 400 });
      }
      // la size si ricalcola sul prezzo di entrata VERO (può differire da quello suggerito),
      // con lo stesso capitale/rischio% di tutto il resto del sito.
      const capitale = parseFloat(process.env.CAPITALE || "950");
      const rischioPct = parseFloat(process.env.RISCHIO_PCT || "2");
      const sizing = calcolaSize(capitale, rischioPct, Math.abs(entrata - stop));
      const op = await apriOperazione({
        lato,
        entrata,
        stop,
        t1,
        t2,
        lotti: sizing.lotti,
        rischioUsd: sizing.rischioUsd,
        motivo: motivo || "",
        apertaIl,
      });
      return NextResponse.json({ ok: true, operazione: op });
    }

    if (body.azione === "chiudi") {
      const { id, esito, uscita } = body;
      if (typeof id !== "number" || typeof uscita !== "number" || !Number.isFinite(uscita)) {
        return NextResponse.json({ ok: false, errore: "dati mancanti o non validi" }, { status: 400 });
      }
      const op = await chiudiOperazione(id, esito || "manuale", uscita);
      return NextResponse.json({ ok: true, operazione: op });
    }

    if (body.azione === "modifica") {
      const { id, stop, t1, t2 } = body;
      if (typeof id !== "number") {
        return NextResponse.json({ ok: false, errore: "id mancante" }, { status: 400 });
      }
      for (const v of [stop, t1, t2]) {
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
          return NextResponse.json({ ok: false, errore: "valore non valido" }, { status: 400 });
        }
      }
      const op = await modificaOperazione(id, { stop, t1, t2 });
      return NextResponse.json({ ok: true, operazione: op });
    }

    return NextResponse.json({ ok: false, errore: "azione sconosciuta (usa 'apri', 'chiudi' o 'modifica')" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, errore: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
