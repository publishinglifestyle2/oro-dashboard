import { Candela } from "./candele";

interface OandaCandela {
  time: string;
  complete: boolean;
  volume: number;
  mid: { o: string; h: string; l: string; c: string };
}

async function fetchGranularita(
  token: string,
  env: string,
  granularity: string,
  count: number
): Promise<Candela[]> {
  const host = env === "practice" ? "api-fxpractice.oanda.com" : "api-fxtrade.oanda.com";
  const url = `https://${host}/v3/instruments/XAU_USD/candles?granularity=${granularity}&price=M&count=${count}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Accept-Datetime-Format": "UNIX" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`oanda ${granularity}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { candles: OandaCandela[] };
  return data.candles
    .filter((c) => c.complete)
    .map((c) => ({
      time: Math.round(parseFloat(c.time) * 1000),
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume,
      completa: true,
    }));
}

/** candele 1h (~30 giorni), 15m (~5 giorni) e 5m (~3 giorni, per superare i weekend) direttamente da oanda,
 * senza dover ricampionare dal minuto: più veloce e più leggero a ogni richiesta della dashboard. */
export async function fetchOandaTutto(token: string, env: string) {
  const [h1, m15, m5] = await Promise.all([
    fetchGranularita(token, env, "H1", 720),
    fetchGranularita(token, env, "M15", 500),
    fetchGranularita(token, env, "M5", 850),
  ]);
  return { h1, m15, m5 };
}
