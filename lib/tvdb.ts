import { Candela, ricampiona } from "./candele";
import { getSql } from "./db";

// la fonte viva (candele_1m) tiene solo una finestra recente: il resto del contesto (10 giorni
// per i pivot 1h, 3 giorni per i pivot 15m — vedi lib/motore.ts) vive nelle tabelle aggregate,
// aggiornate un pezzo alla volta dal webhook (vedi app/api/webhook/tradingview/route.ts). Così
// ogni lettura resta piccola anche restando a 1 minuto sulla fonte viva: è quello che ha esaurito
// la quota di trasferimento di Neon la prima volta (rileggevamo tutto lo storico ad ogni giro).
const ORE_GREZZE = 8; // finestra 1m: basta e avanza per il quadro 5m e il dettaglio del grafico
const GIORNI_15M = 4; // margine sopra i 3 giorni che servono ai pivot 15m
const GIORNI_1H = 12; // margine sopra i 10 giorni che servono ai pivot 1h

const CACHE_MS = 75_000; // più lunga dell'intervallo fra due candele 1m (60s): la cache regge davvero
let cache: { scadenza: number; dati: { h1: Candela[]; m15: Candela[]; m5: Candela[]; m1: Candela[] } } | null = null;

type RigaCandela = { t: string | number; open: number; high: number; low: number; close: number; volume: number };

function aCandele(righe: RigaCandela[]): Candela[] {
  return righe
    .reverse()
    .map((r) => ({
      time: Number(r.t),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      completa: true,
    }));
}

/** legge la fonte viva (candele_1m, finestra corta) più le due tabelle aggregate (15m/1h, storico
 * lungo ma leggero) e ricostruisce il quadro multi-timeframe. Il 5m per il motore/grafico si
 * ricampiona dalla finestra corta di 1m: è sempre "vero" 5 minuti concluso, indipendentemente da
 * quanto spesso arrivano le candele grezze.
 * restituisce null se il database non è ancora configurato o non ha abbastanza storico
 * (in quel caso l'API ricade su OANDA/Yahoo). */
export async function fetchDbTutto(): Promise<{ h1: Candela[]; m15: Candela[]; m5: Candela[]; m1: Candela[] } | null> {
  if (!process.env.DATABASE_URL) return null;
  if (cache && cache.scadenza > Date.now()) return cache.dati;

  const sql = getSql();
  const ora = Date.now();
  const [righeM1, righe15, righe1h] = (await Promise.all([
    sql`select t, open, high, low, close, volume from candele_1m where t >= ${ora - ORE_GREZZE * 3_600_000} order by t desc`,
    sql`select t, open, high, low, close, volume from candele_15m_agg where t >= ${ora - GIORNI_15M * 86_400_000} order by t desc`,
    sql`select t, open, high, low, close, volume from candele_1h_agg where t >= ${ora - GIORNI_1H * 86_400_000} order by t desc`,
  ])) as unknown as [RigaCandela[], RigaCandela[], RigaCandela[]];
  if (righeM1.length < 12) return null; // meno di un'ora di storico grezzo: non abbastanza per il quadro

  const m1 = aCandele(righeM1);
  const m15Agg = aCandele(righe15);
  const h1Agg = aCandele(righe1h);
  const m5 = ricampiona(m1, 300_000, 60_000);

  // le aggregate coprono lo storico lungo ma si fermano all'ultimo giro completato: l'ultimo
  // pezzo (i minuti di questo 15m/1h ancora in corso) arriva ricampionando la finestra corta di
  // 1m, così il quadro vede sempre il presente anche appena dopo un riavvio del webhook.
  const sogliaM15 = m15Agg.length ? m15Agg[m15Agg.length - 1].time + 900_000 : 0;
  const sogliaH1 = h1Agg.length ? h1Agg[h1Agg.length - 1].time + 3_600_000 : 0;
  const m15 = [...m15Agg, ...ricampiona(m1, 900_000, 60_000).filter((c) => c.time >= sogliaM15)];
  const h1 = [...h1Agg, ...ricampiona(m1, 3_600_000, 60_000).filter((c) => c.time >= sogliaH1)];

  if (m15.length < 40 || h1.length < 40) return null; // storico aggregato non ancora popolato a sufficienza

  const dati = { h1, m15, m5, m1 };
  cache = { scadenza: Date.now() + CACHE_MS, dati };
  return dati;
}
