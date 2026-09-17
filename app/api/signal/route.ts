import { NextResponse } from "next/server";
import { fetchOandaTutto } from "@/lib/oanda";
import { fetchYahooTutto } from "@/lib/yahoo";
import { calcolaSize, costruisciQuadro, costruisciScenari, rischioScenario, rr, valutaTrigger, RR_MINIMO_T2, LOT_STEP } from "@/lib/motore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const token = process.env.OANDA_TOKEN;
    const env = process.env.OANDA_ENV || "practice";
    const capitale = parseFloat(process.env.CAPITALE || "950");
    const rischioPct = parseFloat(process.env.RISCHIO_PCT || "2");

    let h1, m15, m5, fonte: string, affidabile: boolean;
    if (token) {
      ({ h1, m15, m5 } = await fetchOandaTutto(token, env));
      fonte = `OANDA (${env === "practice" ? "conto practice" : "conto live"})`;
      affidabile = true;
    } else {
      ({ h1, m15, m5 } = await fetchYahooTutto());
      fonte = "Yahoo GC=F — ripiego, quota diversa dallo spot e in ritardo: non per operare";
      affidabile = false;
    }

    if (m5.length < 40 || m15.length < 40 || h1.length < 40) {
      throw new Error("dati insufficienti dalla fonte, riprova tra poco");
    }

    const quadro = costruisciQuadro(h1, m15, m5);
    const scenari = costruisciScenari(quadro);
    let segnale = valutaTrigger(m5, quadro, scenari);

    let sizing = null;
    let avviso: string | null = null;
    if (segnale.lato !== "ATTENDI" && segnale.scenario) {
      const s = segnale.scenario;
      if (rr(s, s.t2) < RR_MINIMO_T2) {
        avviso = `scartato: rapporto rischio/rendimento su target 2 (${rr(s, s.t2).toFixed(1)}) sotto il minimo ${RR_MINIMO_T2}`;
        segnale = { lato: "ATTENDI", motivo: avviso };
      } else {
        sizing = calcolaSize(capitale, rischioPct, rischioScenario(s));
        if (sizing.lotti < LOT_STEP) {
          avviso = `${s.lato} su ${Math.round(s.entrata)} valido ma stop di ${rischioScenario(s).toFixed(1)}$ troppo largo per ${capitale} usd: nessuna size disponibile`;
        }
      }
    }

    const ritardoMin = (Date.now() - quadro.t) / 60000;

    return NextResponse.json({
      ok: true,
      fonte,
      affidabile,
      ritardoMin,
      generatoAlle: new Date().toISOString(),
      quadro,
      scenari,
      segnale,
      sizing,
      avviso,
      capitale,
      rischioPct,
    });
  } catch (e) {
    const messaggio = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, errore: messaggio }, { status: 500 });
  }
}
