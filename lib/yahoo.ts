import { Candela, ricampiona } from "./candele";

interface YahooRisultato {
  timestamp: number[];
  indicators: { quote: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[] };
}

/** ripiego senza account: future oro CME (GC=F). Quota qualche dollaro sopra lo spot e arriva con
 * 10-15 minuti di ritardo — utile per vedere il sistema funzionare, non per operare davvero. */
async function fetchYahoo1m(): Promise<Candela[]> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=5d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!res.ok) throw new Error(`yahoo: ${res.status}`);
  const data = await res.json();
  const r = data.chart.result[0] as YahooRisultato;
  const q = r.indicators.quote[0];
  const out: Candela[] = [];
  // l'ultima candela della serie è ancora in formazione: la scarto
  for (let i = 0; i < r.timestamp.length - 1; i++) {
    if (q.close[i] == null) continue;
    out.push({
      time: r.timestamp[i] * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] || 0,
      completa: true,
    });
  }
  return out;
}

export async function fetchYahooTutto() {
  const m1 = await fetchYahoo1m();
  return {
    h1: ricampiona(m1, 3600_000),
    m15: ricampiona(m1, 900_000),
    m5: ricampiona(m1, 300_000),
  };
}
