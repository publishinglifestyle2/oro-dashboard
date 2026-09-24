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
 * (come il bot locale) parte con solo i rimbalzi sui livelli nella direzione del trend.
 * "slancio" (vedi sotto, funzione rilevaSlancio) resta nel codice ma è spento: aggiunto il 21/09
 * per seguire entrate discrezionali di quel giorno, poi verificato su 103 episodi storici e sui
 * 26 trade reali del 22-24/09 — solo il 14% degli episodi risolti raggiungeva il target 2 prima
 * dello stop, e i trade reali concordi con "slancio" hanno perso in totale (-735,83 $, 2 BUY su 2
 * perdenti). Riattivabile aggiungendolo di nuovo qui, se in futuro si trova un filtro che funziona
 * davvero (un tentativo — rapporto spinta/atr5 ed efficienza del movimento — non ha retto alla
 * prova sui 103 episodi: nessuna fascia prevedeva l'esito in modo pulito). */
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

/** target 2 = il prossimo livello strutturale (r2/r3/s2/s3), ma solo se non è troppo lontano:
 * quando il livello forte successivo è distante (perché quello nel mezzo è troppo debole per
 * essere considerato, vedi scegli() sopra), il target diventava spesso irraggiungibile — sui
 * dati storici il t2 strutturale veniva toccato prima dello stop solo nel 20% dei casi, contro
 * il 31% mettendo questo tetto a 2.5× il rischio (stesso multiplo già usato per "slancio"). */
const CAP_T2_RISCHIO = 2.5;

export function costruisciScenari(q: Quadro): [Scenario, Scenario, Scenario, Scenario] {
  const buf = Math.max(BUF_K * q.atr15, 3.0);
  return [
    {
      nome: "long rimbalzo",
      lato: "BUY",
      entrata: q.s1,
      stop: q.s1 - buf,
      t1: q.r1,
      t2: Math.min(q.r2, q.s1 + buf * CAP_T2_RISCHIO),
      condizione: `il prezzo difende ${tondo(q.s1)} con un rimbalzo deciso`,
    },
    {
      nome: "long rottura",
      lato: "BUY",
      entrata: q.r1,
      stop: q.r1 - buf,
      t1: q.r2,
      t2: Math.min(q.r3, q.r1 + buf * CAP_T2_RISCHIO),
      condizione: `il prezzo rompe ${tondo(q.r1)} al rialzo con forza e lo riconquista`,
    },
    {
      nome: "short rottura",
      lato: "SELL",
      entrata: q.s1,
      stop: q.s1 + buf,
      t1: q.s2,
      t2: Math.max(q.s3, q.s1 - buf * CAP_T2_RISCHIO),
      condizione: `il prezzo perde ${tondo(q.s1)} e ci rientra sotto con decisione`,
    },
    {
      nome: "short rimbalzo",
      lato: "SELL",
      entrata: q.r1,
      stop: q.r1 + buf,
      t1: q.s1,
      t2: Math.max(q.s2, q.r1 - buf * CAP_T2_RISCHIO),
      condizione: `il prezzo viene respinto da ${tondo(q.r1)} con decisione`,
    },
  ];
}

export interface Segnale {
  lato: "BUY" | "SELL" | "ATTENDI";
  scenario?: Scenario;
  motivo: string;
}

export interface Slancio {
  lato: "BUY" | "SELL";
  spinta: number;
  alto: number;
  basso: number;
}

/** legge solo le ultime candele 5m concluse (niente livelli, niente trend orario): un movimento
 * netto e deciso, con poco va-e-vieni, indipendentemente da dove sta il prezzo rispetto a
 * vwap/s1/r1 o da cosa dice il trend a 1h. Il "rimbalzo" aspetta che il prezzo tocchi un bordo;
 * questo cattura chi compra/vende forza già in corsa (o una rottura di struttura a breve termine
 * anche contro il trend orario) — il tipo di entrata del 21/09. Soglie tarate empiricamente:
 * K=6 candele, spinta netta >= 3× l'atr di una singola candela 5m ed "efficienza" (netto diviso
 * il percorso reale, wick esclusi) >= 0.65 — sotto queste soglie scattava anche sul rumore
 * normale (>1000 volte in 18 giorni contro le ~230 attuali, vedi test manuale).
 * ESPORTATA e usata SOLO per il promemoria push "guarda il grafico" (vedi webhook/tradingview):
 * su 103 episodi storici solo il 14% raggiungeva un target 2R prima dello stop, quindi non è più
 * usata come setup che consiglia entrata/stop/target precisi (tolta da SETUP_ATTIVI). */
export function rilevaSlancio(concluse: Candela[], atr5: number): Slancio | null {
  const K = 6;
  const SOGLIA_ATR = 3.0;
  const SOGLIA_EFFICIENZA = 0.65;
  if (concluse.length < K) return null;
  const fin = concluse.slice(-K);
  const netto = fin[fin.length - 1].close - fin[0].open;
  if (Math.abs(netto) < SOGLIA_ATR * atr5) return null;
  let precedente = fin[0].open;
  let percorso = 0;
  for (const c of fin) {
    percorso += Math.abs(c.close - precedente);
    precedente = c.close;
  }
  const efficienza = percorso > 0 ? Math.abs(netto) / percorso : 0;
  if (efficienza < SOGLIA_EFFICIENZA) return null;
  const alto = Math.max(...fin.map((c) => c.high));
  const basso = Math.min(...fin.map((c) => c.low));
  return { lato: netto > 0 ? "BUY" : "SELL", spinta: netto, alto, basso };
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

  if (SETUP_ATTIVI.has("slancio")) {
    const s = rilevaSlancio(concluse, q.atr5);
    if (s) {
      const bufS = Math.max(BUF_K * q.atr15, 3.0);
      const entrata = ultima.close;
      if (s.lato === "BUY") {
        const stop = s.basso - bufS;
        const rischio = entrata - stop;
        if (rischio > 0) {
          const sc2: Scenario = {
            nome: "long slancio",
            lato: "BUY",
            entrata,
            stop,
            t1: entrata + rischio * 1.5,
            t2: entrata + rischio * 2.5,
            condizione: `spinta rialzista netta sulle ultime ${6} candele 5m (+${tondo(s.spinta)}$), niente pausa`,
          };
          if (rr(sc2, sc2.t2) >= RR_MINIMO_T2) {
            return { lato: "BUY", scenario: sc2, motivo: `slancio rialzista in corso: prezzo ${tondo(entrata)} spinge da ${tondo(s.basso)}, stop sotto il minimo recente` };
          }
        }
      } else {
        const stop = s.alto + bufS;
        const rischio = stop - entrata;
        if (rischio > 0) {
          const sc2: Scenario = {
            nome: "short slancio",
            lato: "SELL",
            entrata,
            stop,
            t1: entrata - rischio * 1.5,
            t2: entrata - rischio * 2.5,
            condizione: `spinta ribassista netta sulle ultime ${6} candele 5m (${tondo(s.spinta)}$), niente pausa`,
          };
          if (rr(sc2, sc2.t2) >= RR_MINIMO_T2) {
            return { lato: "SELL", scenario: sc2, motivo: `slancio ribassista in corso: prezzo ${tondo(entrata)} scarica da ${tondo(s.alto)}, stop sopra il massimo recente` };
          }
        }
      }
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
