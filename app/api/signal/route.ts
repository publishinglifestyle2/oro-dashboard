import { NextResponse } from "next/server";
import { fetchOandaTutto } from "@/lib/oanda";
import { fetchYahooTutto } from "@/lib/yahoo";
import { fetchDbTutto } from "@/lib/tvdb";
import { calcolaSize, costruisciQuadro, costruisciScenari, rischioScenario, rr, valutaTrigger, RR_MINIMO_T2, LOT_STEP } from "@/lib/motore";
import { epochGraficoRoma } from "@/lib/candele";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const token = process.env.OANDA_TOKEN;
    const env = process.env.OANDA_ENV || "practice";
    const capitale = parseFloat(process.env.CAPITALE || "950");
    const rischioPct = parseFloat(process.env.RISCHIO_PCT || "2");
    // di default sempre attivo (0-24): il backtest però copre solo 9-18, fuori da lì
    // il motore segnala su condizioni mai verificate. per tornare alla finestra testata,
    // imposta ORA_INIZIO=9 e ORA_FINE=18 su Vercel.
    const oraInizio = parseFloat(process.env.ORA_INIZIO || "0");
    const oraFine = parseFloat(process.env.ORA_FINE || "24");

    let h1, m15, m5, m1, fonte: string, affidabile: boolean, minutiCandela: number;
    const daTradingView = await fetchDbTutto().catch(() => null);
    if (daTradingView) {
      ({ h1, m15, m5, m1 } = daTradingView);
      fonte = "TradingView Premium (webhook in tempo reale, 1 minuto)";
      affidabile = true;
      minutiCandela = 1;
    } else if (token) {
      ({ h1, m15, m5, m1 } = await fetchOandaTutto(token, env));
      fonte = `OANDA (${env === "practice" ? "conto practice" : "conto live"})`;
      affidabile = true;
      minutiCandela = 1;
    } else {
      ({ h1, m15, m5, m1 } = await fetchYahooTutto());
      fonte = "Yahoo GC=F — ripiego, quota diversa dallo spot e in ritardo: non per operare";
      affidabile = false;
      minutiCandela = 1;
    }

    if (m5.length < 40 || m15.length < 40 || h1.length < 40) {
      throw new Error("dati insufficienti dalla fonte, riprova tra poco");
    }

    const quadro = costruisciQuadro(h1, m15, m5);
    const scenari = costruisciScenari(quadro);
    let segnale = valutaTrigger(m5, quadro, scenari, oraInizio, oraFine);

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

    // per il grafico: candele più fini disponibili (1m su oanda/yahoo/tradingview, 5m di
    // ripiego). il tempo va convertito con epochGraficoRoma, non un banale /1000: lightweight-
    // charts mostra sempre i timestamp come se fossero UTC, quindi senza questo l'asse appariva
    // 2 ore indietro rispetto all'ora italiana (differenza ora legale a settembre).
    const fonteGrafico = m1 && m1.length > 0 ? m1 : m5;
    const candeleGrafico = fonteGrafico.slice(-300).map((c) => ({
      time: epochGraficoRoma(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

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
      candeleGrafico,
      minutiCandela,
    });
  } catch (e) {
    const messaggio = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, errore: messaggio }, { status: 500 });
  }
}
