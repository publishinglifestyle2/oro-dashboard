import { Candela, ricampiona } from "./candele";
import { getSql } from "./db";

const GIORNI_STORICO = 30;
const CANDELE_AL_GIORNO = 288; // 24h * 60min / 5min
const RIGHE_MAX = GIORNI_STORICO * CANDELE_AL_GIORNO;

/** legge le candele 5m ricevute via webhook da TradingView (candele_5m) e ricampiona 15m/1h da
 * quelle — il 5m stesso arriva già pronto, non serve costruirlo dal minuto. Una candela ogni 5
 * minuti invece che ogni minuto tiene il database Neon libero di riaddormentarsi tra una chiamata
 * e l'altra (con una candela al minuto restava sempre sveglio, consumando la quota gratuita in
 * un paio di giorni invece che in un mese). Il motore comunque decide solo su chiusure 5m: nessuna
 * differenza nelle decisioni, solo nel dettaglio del grafico (5m invece di 1m).
 * restituisce null se il database non è ancora configurato o non ha abbastanza storico
 * (in quel caso l'API ricade su OANDA/Yahoo). */
export async function fetchDbTutto(): Promise<{ h1: Candela[]; m15: Candela[]; m5: Candela[] } | null> {
  if (!process.env.DATABASE_URL) return null;
  const sql = getSql();
  const righe = (await sql`
    select t, open, high, low, close, volume from candele_5m order by t desc limit ${RIGHE_MAX}
  `) as { t: string | number; open: number; high: number; low: number; close: number; volume: number }[];
  if (righe.length < 12) return null; // meno di un'ora di storico: non abbastanza per il quadro
  const m5: Candela[] = righe
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
  return {
    h1: ricampiona(m5, 3_600_000, 300_000),
    m15: ricampiona(m5, 900_000, 300_000),
    m5,
  };
}
