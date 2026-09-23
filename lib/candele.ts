// tipi e utilità numeriche di base, comuni a qualunque fonte dati.

export interface Candela {
  time: number; // istante di apertura, epoch ms (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  completa: boolean;
}

/** media mobile esponenziale, stessa formula di pandas .ewm(span=n, adjust=False).mean() */
export function emaSerie(valori: number[], span: number): number[] {
  const alpha = 2 / (span + 1);
  const out: number[] = [valori[0]];
  for (let i = 1; i < valori.length; i++) out.push(alpha * valori[i] + (1 - alpha) * out[i - 1]);
  return out;
}

/** average true range, stessa formula di pandas .ewm(alpha=1/n, adjust=False).mean() */
export function atrSerie(candele: Candela[], n = 14): number[] {
  const tr = candele.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candele[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  const alpha = 1 / n;
  const out: number[] = [tr[0]];
  for (let i = 1; i < tr.length; i++) out.push(alpha * tr[i] + (1 - alpha) * out[i - 1]);
  return out;
}

/** massimi/minimi locali confermati da n barre su entrambi i lati (finestra centrata 2n+1) */
export function pivotAlti(c: Candela[], n: number): { prezzo: number; idx: number }[] {
  const out: { prezzo: number; idx: number }[] = [];
  for (let i = n; i < c.length - n; i++) {
    let max = -Infinity;
    for (let j = i - n; j <= i + n; j++) max = Math.max(max, c[j].high);
    if (c[i].high === max) out.push({ prezzo: c[i].high, idx: i });
  }
  return out;
}

export function pivotBassi(c: Candela[], n: number): { prezzo: number; idx: number }[] {
  const out: { prezzo: number; idx: number }[] = [];
  for (let i = n; i < c.length - n; i++) {
    let min = Infinity;
    for (let j = i - n; j <= i + n; j++) min = Math.min(min, c[j].low);
    if (c[i].low === min) out.push({ prezzo: c[i].low, idx: i });
  }
  return out;
}

export interface Livello {
  prezzo: number;
  tocchi: number;
  fonte: string;
}

export function forza(l: Livello): number {
  return l.tocchi + (l.fonte.includes("oggi") || l.fonte.includes("ieri") ? 3 : 0);
}

/** raggruppa candidati vicini (entro tol) in un unico livello, con media pesata e conteggio tocchi */
export function cluster(cands: { prezzo: number; fonte: string }[], tol: number): Livello[] {
  const ordinati = [...cands].sort((a, b) => a.prezzo - b.prezzo);
  const out: Livello[] = [];
  for (const c of ordinati) {
    const ultimo = out[out.length - 1];
    if (ultimo && Math.abs(c.prezzo - ultimo.prezzo) <= tol) {
      ultimo.prezzo = (ultimo.prezzo * ultimo.tocchi + c.prezzo) / (ultimo.tocchi + 1);
      ultimo.tocchi += 1;
      if (!ultimo.fonte.includes(c.fonte)) ultimo.fonte += "+" + c.fonte;
    } else {
      out.push({ prezzo: c.prezzo, tocchi: 1, fonte: c.fonte });
    }
  }
  return out;
}

/** raggruppa candele più fini in candele più larghe (bucket allineati all'epoca).
 * granularitaFonteMs = passo delle candele in ingresso (default 1 minuto): serve per capire
 * se l'ULTIMO bucket è ancora in formazione (gli mancano dei minuti) — altrimenti il motore
 * rischierebbe di valutare un trigger su una candela 5m/15m/1h non ancora chiusa. I bucket
 * precedenti restano sempre "conclusi": per definizione hanno già tutti i dati che avranno mai. */
export function ricampiona(candele: Candela[], intervalloMs: number, granularitaFonteMs = 60_000): Candela[] {
  const bucket = new Map<number, Candela[]>();
  for (const c of candele) {
    const chiave = Math.floor(c.time / intervalloMs) * intervalloMs;
    if (!bucket.has(chiave)) bucket.set(chiave, []);
    bucket.get(chiave)!.push(c);
  }
  const chiavi = [...bucket.keys()].sort((a, b) => a - b);
  const attesiPerBucket = intervalloMs / granularitaFonteMs;
  return chiavi.map((k, i) => {
    const g = bucket.get(k)!;
    const ultimo = i === chiavi.length - 1;
    return {
      time: k,
      open: g[0].open,
      close: g[g.length - 1].close,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      volume: g.reduce((s, c) => s + c.volume, 0),
      completa: !ultimo || g.length >= attesiPerBucket,
    };
  });
}

export function tondo(x: number): number {
  return Math.round(x);
}

export function formattaUsd(x: number, dec = 0): string {
  return x.toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

const FMT_ROMA = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Rome",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

/** anno/mese/giorno/ora/minuto/giorno-settimana (0=domenica) nell'ora italiana, per un istante epoch ms */
export function partiRoma(ms: number) {
  const parts = FMT_ROMA.formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const ora24 = +get("hour");
  return {
    anno: +get("year"),
    mese: +get("month"),
    giorno: +get("day"),
    ora: ora24 === 24 ? 0 : ora24,
    minuto: +get("minute"),
    weekday: map[get("weekday")],
  };
}

export function chiaveGiornoRoma(ms: number): string {
  const p = partiRoma(ms);
  return `${p.anno}-${String(p.mese).padStart(2, "0")}-${String(p.giorno).padStart(2, "0")}`;
}

/** epoch (in secondi) da passare al grafico (lightweight-charts) perché l'asse mostri l'ora
 * italiana: la libreria non supporta un fuso arbitrario, tratta sempre il timestamp come UTC —
 * qui si "spacciano" per UTC le stesse cifre dell'orologio di Roma (funziona anche a cavallo
 * del cambio ora legale/solare, perché parte da partiRoma() invece di un offset fisso). */
export function epochGraficoRoma(ms: number): number {
  const p = partiRoma(ms);
  return Math.floor(Date.UTC(p.anno, p.mese - 1, p.giorno, p.ora, p.minuto) / 1000);
}
