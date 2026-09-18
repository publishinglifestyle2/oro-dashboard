import { Candela, ricampiona } from "./candele";
import { getSql } from "./db";

const GIORNI_STORICO = 30;
const RIGHE_MAX = GIORNI_STORICO * 1440; // 1 candela al minuto

/** legge le candele 1m ricevute via webhook da TradingView e le ricampiona in 1h/15m/5m.
 * restituisce null se il database non è ancora configurato o non ha abbastanza storico
 * (in quel caso l'API ricade su OANDA/Yahoo). */
export async function fetchDbTutto(): Promise<{ h1: Candela[]; m15: Candela[]; m5: Candela[]; m1: Candela[] } | null> {
  if (!process.env.DATABASE_URL) return null;
  const sql = getSql();
  const righe = (await sql`
    select t, open, high, low, close, volume from candele_1m order by t desc limit ${RIGHE_MAX}
  `) as { t: string | number; open: number; high: number; low: number; close: number; volume: number }[];
  if (righe.length < 60) return null; // meno di un'ora di storico: non abbastanza per il quadro
  const m1: Candela[] = righe
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
  return { h1: ricampiona(m1, 3_600_000), m15: ricampiona(m1, 900_000), m5: ricampiona(m1, 300_000), m1 };
}
