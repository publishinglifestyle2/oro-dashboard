import { Candela, ricampiona } from "./candele";
import { getSql } from "./db";

// il motore usa pivot su 10 giorni (1h) e 3 giorni (15m) — vedi lib/motore.ts. 12 giorni dà un
// margine piccolo senza scaricare storia che nessuno guarda: prima erano 30, che con la dashboard
// che interroga /api/signal ogni 60 secondi ha consumato in 3 giorni tutto il trasferimento dati
// mensile gratuito di Neon (5,54 GB) — non erano le ore di calcolo, era proprio il volume di dati
// riletto a ogni giro.
const GIORNI_STORICO = 12;
const CANDELE_AL_GIORNO = 288; // 24h * 60min / 5min
const RIGHE_MAX = GIORNI_STORICO * CANDELE_AL_GIORNO;

// piccola cache in memoria: la dashboard chiede questi dati ogni 60 secondi (o più spesso se hai
// più schede aperte), ma una candela nuova arriva solo ogni 5 minuti — non serve rileggere tutto
// dal database a ogni singola richiesta. Su Vercel (Fluid Compute) l'istanza spesso resta viva tra
// una richiesta e l'altra, quindi questa cache taglia per davvero il trasferimento dati reale.
const CACHE_MS = 45_000;
let cache: { scadenza: number; dati: { h1: Candela[]; m15: Candela[]; m5: Candela[] } } | null = null;

/** legge le candele 5m ricevute via webhook da TradingView (candele_5m) e ricampiona 15m/1h da
 * quelle — il 5m stesso arriva già pronto, non serve costruirlo dal minuto. Una candela ogni 5
 * minuti invece che ogni minuto tiene il database Neon libero di riaddormentarsi tra una chiamata
 * e l'altra (con una candela al minuto restava sempre sveglio, consumando ore di calcolo). Il
 * motore comunque decide solo su chiusure 5m: nessuna differenza nelle decisioni, solo nel
 * dettaglio del grafico (5m invece di 1m).
 * restituisce null se il database non è ancora configurato o non ha abbastanza storico
 * (in quel caso l'API ricade su OANDA/Yahoo). */
export async function fetchDbTutto(): Promise<{ h1: Candela[]; m15: Candela[]; m5: Candela[] } | null> {
  if (!process.env.DATABASE_URL) return null;
  if (cache && cache.scadenza > Date.now()) return cache.dati;

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
  const dati = {
    h1: ricampiona(m5, 3_600_000, 300_000),
    m15: ricampiona(m5, 900_000, 300_000),
    m5,
  };
  cache = { scadenza: Date.now() + CACHE_MS, dati };
  return dati;
}
