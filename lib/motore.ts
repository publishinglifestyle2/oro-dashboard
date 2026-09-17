// porting in typescript del motore di oro.py: stesso quadro multi-timeframe, stessi livelli,
// stesso trigger sulle candele 5 minuti concluse, stessa size al rischio impostato.
import {
  Candela,
  Livello,
  atrSerie,
  chiaveGiornoRoma,
  cluster,
  emaSerie,
  forza,
  partiRoma,
  pivotAlti,
  pivotBassi,
  tondo,
} from "./candele";

export const OZ_PER_LOTTO = 100;
export const LOT_STEP = 0.01;
export const SPREAD_STIMATO = 0.35; // costo indicativo andata+ritorno in dollari
export const ORA_INIZIO = 9;
export const ORA_FINE = 18;
export const BUF_K = 0.6; // stop = livello ± BUF_K × atr 15m (minimo 3 dollari)
export const RR_MINIMO_T2 = 1.5;
/** setup che il motore può segnalare: nel backtest le rotture perdevano, quindi la dashboard
 * (come il bot locale) parte con solo i rimbalzi sui livelli nella direzione del trend. */
export const SETUP_ATTIVI = new Set(["rimbalzo"]);

export interface Quadro {
  t: number; // istante dell'ultima candela 5m, epoch ms
  prezzo: number;
  atr5: number;
  atr15: number;
  atr1h: number;
  trend1h: string;
  trend15: string;
  ema1h: [number, number, number];
  ema15: [number, number];
  vwap: number;
  dayHi: number;
  dayLo: number;
  dayOpen: number;
  prevHi: number;
  prevLo: number;
  prevClose: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
  livelli: Livello[];
}

export function costruisciQuadro(h1: Candela[], m15: Candela[], m5: Candela[]): Quadro {
  const ultima5 = m5[m5.length - 1];
  const t = ultima5.time;
  const prezzo = ultima5.close;

  const a5 = atrSerie(m5, 14).at(-1)!;
  const a15Serie = atrSerie(m15, 14);
  const a15 = a15Serie.at(-1)!;
  const a1h = atrSerie(h1, 14).at(-1)!;

  const e20hS = emaSerie(h1.map((c) => c.close), 20);
  const e50hS = emaSerie(h1.map((c) => c.close), 50);
  const e200hS = emaSerie(h1.map((c) => c.close), 200);
  const e20h = e20hS.at(-1)!;
  const e50h = e50hS.at(-1)!;
  const e200h = e200hS.at(-1)!;
  const slope = e20hS.at(-1)! - (e20hS.at(-4) ?? e20hS[0]);

  const e20qS = emaSerie(m15.map((c) => c.close), 20);
  const e50qS = emaSerie(m15.map((c) => c.close), 50);
  const e20q = e20qS.at(-1)!;
  const e50q = e50qS.at(-1)!;

  let trend1h: string;
  if (e20h > e50h && prezzo > e20h && slope > 0) trend1h = "rialzista";
  else if (e20h < e50h && prezzo < e20h && slope < 0) trend1h = "ribassista";
  else if (e20h > e50h) trend1h = "rialzista in pausa";
  else if (e20h < e50h) trend1h = "ribassista in pausa";
  else trend1h = "laterale";
  const trend15 = e20q > e50q ? "rialzista" : "ribassista";

  const oggiChiave = chiaveGiornoRoma(t);
  const oggi = m5.filter((c) => chiaveGiornoRoma(c.time) === oggiChiave);
  const primaDiOggi = m5.filter((c) => chiaveGiornoRoma(c.time) < oggiChiave);
  let ieri = oggi;
  if (primaDiOggi.length) {
    const chiaveIeri = chiaveGiornoRoma(primaDiOggi[primaDiOggi.length - 1].time);
    ieri = primaDiOggi.filter((c) => chiaveGiornoRoma(c.time) === chiaveIeri);
  }

  const dayHi = Math.max(...oggi.map((c) => c.high));
  const dayLo = Math.min(...oggi.map((c) => c.low));
  const dayOpen = oggi[0].open;

  const volSum = oggi.reduce((s, c) => s + c.volume, 0);
  const vwap =
    volSum > 0
      ? oggi.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / volSum
      : oggi.reduce((s, c) => s + c.close, 0) / oggi.length;

  // candidati livelli: pivot 15m (3 giorni), pivot 1h (10 giorni), estremi di oggi/ieri
  const cands: { prezzo: number; fonte: string }[] = [];
  const m15Recenti = m15.filter((c) => c.time >= t - 3 * 86_400_000);
  for (const p of pivotAlti(m15Recenti, 3)) cands.push({ prezzo: p.prezzo, fonte: "15m" });
  for (const p of pivotBassi(m15Recenti, 3)) cands.push({ prezzo: p.prezzo, fonte: "15m" });
  const h1Recenti = h1.filter((c) => c.time >= t - 10 * 86_400_000);
  for (const p of pivotAlti(h1Recenti, 2)) cands.push({ prezzo: p.prezzo, fonte: "1h" });
  for (const p of pivotBassi(h1Recenti, 2)) cands.push({ prezzo: p.prezzo, fonte: "1h" });
  cands.push({ prezzo: dayHi, fonte: "max oggi" }, { prezzo: dayLo, fonte: "min oggi" });
  cands.push(
    { prezzo: Math.max(...ieri.map((c) => c.high)), fonte: "max ieri" },
    { prezzo: Math.min(...ieri.map((c) => c.low)), fonte: "min ieri" }
  );
  const tol = Math.max(0.35 * a15, 2.0);
  const liv = cluster(cands, tol);

  const dmin = 0.15 * a15;
  const sep = 0.9 * a15;
  const sopra = liv.filter((l) => l.prezzo - prezzo >= dmin).sort((a, b) => a.prezzo - b.prezzo);
  const sotto = liv.filter((l) => prezzo - l.prezzo >= dmin).sort((a, b) => b.prezzo - a.prezzo);

  function scegli(lst: Livello[], verso: 1 | -1): [number, number, number] {
    const forti = lst.filter((l) => forza(l) >= 2);
    const pool = forti.length ? forti : lst;
    const out: number[] = [];
    for (const l of pool) {
      if (!out.length || Math.abs(l.prezzo - out[out.length - 1]) >= sep) out.push(l.prezzo);
      if (out.length === 3) break;
    }
    let base = out.length ? out[out.length - 1] : prezzo;
    while (out.length < 3) {
      base += verso * 1.2 * a15;
      out.push(base);
    }
    return out as [number, number, number];
  }

  const [r1, r2, r3] = scegli(sopra, 1);
  const [s1, s2, s3] = scegli(sotto, -1);

  return {
    t,
    prezzo,
    atr5: a5,
    atr15: a15,
    atr1h: a1h,
    trend1h,
    trend15,
    ema1h: [e20h, e50h, e200h],
    ema15: [e20q, e50q],
    vwap,
    dayHi,
    dayLo,
    dayOpen,
    prevHi: Math.max(...ieri.map((c) => c.high)),
    prevLo: Math.min(...ieri.map((c) => c.low)),
    prevClose: ieri[ieri.length - 1].close,
    r1,
    r2,
    r3,
    s1,
    s2,
    s3,
    livelli: liv,
  };
}

export interface Scenario {
  nome: string;
  lato: "BUY" | "SELL";
  entrata: number;
  stop: number;
  t1: number;
  t2: number;
  condizione: string;
}

export function rischioScenario(s: Scenario): number {
  return Math.abs(s.entrata - s.stop);
}

export function rr(s: Scenario, target: number): number {
  const r = rischioScenario(s);
  return r ? Math.abs(target - s.entrata) / r : 0;
}

export function costruisciScenari(q: Quadro): [Scenario, Scenario, Scenario, Scenario] {
  const buf = Math.max(BUF_K * q.atr15, 3.0);
  return [
    {
      nome: "long rimbalzo",
      lato: "BUY",
      entrata: q.s1,
      stop: q.s1 - buf,
      t1: q.r1,
      t2: q.r2,
      condizione: `il prezzo difende ${tondo(q.s1)} con un rimbalzo deciso`,
    },
    {
      nome: "long rottura",
      lato: "BUY",
      entrata: q.r1,
      stop: q.r1 - buf,
      t1: q.r2,
      t2: q.r3,
      condizione: `il prezzo rompe ${tondo(q.r1)} al rialzo con forza e lo riconquista`,
    },
    {
      nome: "short rottura",
      lato: "SELL",
      entrata: q.s1,
      stop: q.s1 + buf,
      t1: q.s2,
      t2: q.s3,
      condizione: `il prezzo perde ${tondo(q.s1)} e ci rientra sotto con decisione`,
    },
    {
      nome: "short rimbalzo",
      lato: "SELL",
      entrata: q.r1,
      stop: q.r1 + buf,
      t1: q.s1,
      t2: q.s2,
      condizione: `il prezzo viene respinto da ${tondo(q.r1)} con decisione`,
    },
  ];
}

export interface Segnale {
  lato: "BUY" | "SELL" | "ATTENDI";
  scenario?: Scenario;
  motivo: string;
}

/** valuta solo le ultime due candele 5m CONCLUSE, esattamente come il bot locale.
 * oraInizio/oraFine sono configurabili (env ORA_INIZIO/ORA_FINE): il backtest è stato fatto
 * sulla finestra 9-18, fuori da lì il motore opera su condizioni mai verificate. */
export function valutaTrigger(
  m5: Candela[],
  q: Quadro,
  sc: [Scenario, Scenario, Scenario, Scenario],
  oraInizio: number = ORA_INIZIO,
  oraFine: number = ORA_FINE
): Segnale {
  const concluse = m5.filter((c) => c.completa);
  if (concluse.length < 3) return { lato: "ATTENDI", motivo: "dati insufficienti" };
  const ultima = concluse[concluse.length - 1];
  const prima = concluse[concluse.length - 2];

  const { ora, minuto, weekday } = partiRoma(q.t);
  const oraDecimale = ora + minuto / 60;
  if (!(oraDecimale >= oraInizio && oraDecimale < oraFine)) {
    return {
      lato: "ATTENDI",
      motivo: `fuori orario (${String(ora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}): si opera solo ${String(oraInizio).padStart(2, "0")}:00-${String(oraFine).padStart(2, "0")}:00`,
    };
  }
  // il weekend resta bloccato sempre: qui il mercato dell'oro è chiuso, non è una scelta di strategia.
  if (weekday === 0 || weekday === 6) return { lato: "ATTENDI", motivo: "mercati chiusi nel weekend" };

  const a5Serie = atrSerie(m5, 14);
  const mediaRecente = a5Serie.slice(-60).reduce((s, v) => s + v, 0) / Math.min(60, a5Serie.length);
  if (q.atr5 > 2.5 * mediaRecente) {
    return { lato: "ATTENDI", motivo: "volatilità anomala sulle ultime candele: niente foga, si aspetta" };
  }

  const [rimb, rott, short, srimb] = sc;
  let bias: "long" | "short" | "neutro";
  if (q.trend1h.startsWith("rialzista") && q.prezzo > q.vwap) bias = "long";
  else if (q.trend1h.startsWith("ribassista") && q.prezzo < q.vwap) bias = "short";
  else bias = "neutro";

  const verde = ultima.close > ultima.open;
  const rossa = ultima.close < ultima.open;
  const buf = Math.max(BUF_K * q.atr15, 3.0);

  if (SETUP_ATTIVI.has("rottura") && bias === "long" && q.trend15 === "rialzista" && verde) {
    const rottiSu = q.livelli.filter((l) => forza(l) >= 2 && prima.close <= l.prezzo && l.prezzo < ultima.close);
    if (rottiSu.length) {
      const l = rottiSu.reduce((a, b) => (a.prezzo > b.prezzo ? a : b));
      const s: Scenario = { ...rott, entrata: ultima.close, stop: l.prezzo - buf };
      if (rr(s, s.t1) >= 1.0)
        return { lato: "BUY", scenario: s, motivo: `rottura di ${tondo(l.prezzo)} confermata in chiusura 5m, 1h e 15m rialzisti` };
      return { lato: "ATTENDI", motivo: `rottura di ${tondo(l.prezzo)} ma target troppo vicino: non rincorro` };
    }
  }
  if (SETUP_ATTIVI.has("rimbalzo") && bias === "long" && verde) {
    const soglia = q.s1 + 0.2 * q.atr5;
    if (ultima.low <= soglia && soglia < ultima.close && ultima.close > (ultima.high + ultima.low) / 2) {
      const s: Scenario = { ...rimb, entrata: ultima.close };
      if (rr(s, s.t1) >= 1.0)
        return { lato: "BUY", scenario: s, motivo: `difesa di ${tondo(q.s1)} con rimbalzo deciso in chiusura 5m, 1h rialzista` };
    }
  }
  if (SETUP_ATTIVI.has("rottura") && bias === "short" && q.trend15 === "ribassista" && rossa) {
    const rottiGiu = q.livelli.filter((l) => forza(l) >= 2 && ultima.close < l.prezzo && l.prezzo <= prima.close);
    if (rottiGiu.length) {
      const l = rottiGiu.reduce((a, b) => (a.prezzo < b.prezzo ? a : b));
      const s: Scenario = { ...short, entrata: ultima.close, stop: l.prezzo + buf };
      if (rr(s, s.t1) >= 1.0)
        return { lato: "SELL", scenario: s, motivo: `perdita di ${tondo(l.prezzo)} confermata in chiusura 5m, 1h e 15m ribassisti` };
      return { lato: "ATTENDI", motivo: `perdita di ${tondo(l.prezzo)} ma target troppo vicino: non rincorro` };
    }
  }
  if (SETUP_ATTIVI.has("rimbalzo") && bias === "short" && rossa) {
    const soglia = q.r1 - 0.2 * q.atr5;
    if (ultima.high >= soglia && soglia > ultima.close && ultima.close < (ultima.high + ultima.low) / 2) {
      const s: Scenario = { ...srimb, entrata: ultima.close };
      if (rr(s, s.t1) >= 1.0)
        return { lato: "SELL", scenario: s, motivo: `rifiuto di ${tondo(q.r1)} con candela 5m di scarico, 1h ribassista` };
    }
  }

  const zona = q.s1 < q.prezzo && q.prezzo < q.r1 ? "rumore fra i livelli" : "sui bordi";
  return { lato: "ATTENDI", motivo: `nessuna conferma (bias ${bias}): prezzo ${tondo(q.prezzo)} nel ${zona}, aspetto i bordi` };
}

export interface Sizing {
  lotti: number;
  rischioUsd: number;
  rischioPct: number;
}

export function calcolaSize(capitale: number, rischioPct: number, stopDist: number): Sizing {
  const budget = (capitale * rischioPct) / 100;
  let lotti = budget / ((stopDist + SPREAD_STIMATO) * OZ_PER_LOTTO);
  lotti = Math.floor(lotti / LOT_STEP + 1e-9) * LOT_STEP;
  lotti = Math.max(lotti, 0);
  lotti = Math.round(lotti * 100) / 100;
  const rischioUsd = lotti * (stopDist + SPREAD_STIMATO) * OZ_PER_LOTTO;
  return { lotti, rischioUsd, rischioPct: capitale ? (rischioUsd / capitale) * 100 : 0 };
}
