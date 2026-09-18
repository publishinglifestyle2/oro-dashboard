import { NextResponse } from "next/server";
import { assicuraSchemaPush } from "@/lib/db";
import { salvaAbbonamento, rimuoviAbbonamento } from "@/lib/push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let schemaPronto = false;
async function assicura() {
  if (!schemaPronto) {
    await assicuraSchemaPush();
    schemaPronto = true;
  }
}

export async function GET() {
  // il client legge qui la chiave pubblica per potersi abbonare (non è un segreto: è pensata per essere pubblica)
  return NextResponse.json({ ok: true, publicKey: process.env.VAPID_PUBLIC_KEY || null });
}

export async function POST(req: Request) {
  try {
    await assicura();
    const body = await req.json();
    if (body.azione === "abbona") {
      if (!body.subscription?.endpoint || !body.subscription?.keys) {
        return NextResponse.json({ ok: false, errore: "abbonamento non valido" }, { status: 400 });
      }
      await salvaAbbonamento(body.subscription);
      return NextResponse.json({ ok: true });
    }
    if (body.azione === "disabbona") {
      if (body.endpoint) await rimuoviAbbonamento(body.endpoint);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, errore: "azione sconosciuta" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, errore: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
