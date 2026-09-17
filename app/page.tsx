"use client";

import { useCallback, useEffect, useState } from "react";

const INTERVALLO_MS = 60_000;

interface Livello {
  prezzo: number;
  tocchi: number;
  fonte: string;
}
interface Quadro {
  t: number;
  prezzo: number;
  atr5: number;
  atr15: number;
  atr1h: number;
  trend1h: string;
  trend15: string;
  ema1h: [number, number, number];
  vwap: number;
  dayHi: number;
  dayLo: number;
  dayOpen: number;
  prevHi: number;
  prevLo: number;
  prevClose: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
  livelli: Livello[];
}
interface Scenario {
  nome: string;
  lato: "BUY" | "SELL";
  entrata: number;
  stop: number;
  t1: number;
  t2: number;
  condizione: string;
}
interface Segnale {
  lato: "BUY" | "SELL" | "ATTENDI";
  scenario?: Scenario;
  motivo: string;
}
interface Sizing {
  lotti: number;
  rischioUsd: number;
  rischioPct: number;
}
interface RispostaApi {
  ok: boolean;
  errore?: string;
  fonte: string;
  affidabile: boolean;
  ritardoMin: number;
  generatoAlle: string;
  quadro: Quadro;
  scenari: [Scenario, Scenario, Scenario, Scenario];
  segnale: Segnale;
  sizing: Sizing | null;
  avviso: string | null;
  capitale: number;
  rischioPct: number;
}

const it = (x: number, dec = 0) => x.toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const tondo = (x: number) => Math.round(x);
const rr = (s: Scenario, target: number) => Math.abs(target - s.entrata) / Math.abs(s.entrata - s.stop);

export default function Dashboard() {
  const [dati, setDati] = useState<RispostaApi | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [caricando, setCaricando] = useState(true);
  const [ultimoFetch, setUltimoFetch] = useState<Date | null>(null);
  const [secondiProssimo, setSecondiProssimo] = useState(60);

  const aggiorna = useCallback(async () => {
    try {
      const res = await fetch("/api/signal", { cache: "no-store" });
      const json: RispostaApi = await res.json();
      if (!json.ok) throw new Error(json.errore || "errore sconosciuto");
      setDati(json);
      setErrore(null);
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e));
    } finally {
      setCaricando(false);
      setUltimoFetch(new Date());
      setSecondiProssimo(60);
    }
  }, []);

  useEffect(() => {
    aggiorna();
    const id = setInterval(aggiorna, INTERVALLO_MS);
    return () => clearInterval(id);
  }, [aggiorna]);

  useEffect(() => {
    const id = setInterval(() => setSecondiProssimo((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-6 space-y-5">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">🟡 assistente oro</h1>
        <div className="text-right text-xs text-neutral-400">
          {ultimoFetch && <div>aggiornato {ultimoFetch.toLocaleTimeString("it-IT")}</div>}
          <div>prossimo tra {secondiProssimo}s · <button onClick={aggiorna} className="underline hover:text-amber-400">aggiorna ora</button></div>
        </div>
      </header>

      {caricando && !dati && <div className="text-neutral-400">carico i dati…</div>}

      {errore && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          errore: {errore}
        </div>
      )}

      {dati && (
        <>
          <FonteBadge fonte={dati.fonte} affidabile={dati.affidabile} ritardoMin={dati.ritardoMin} />
          <PrezzoCard q={dati.quadro} />
          <LivelliCard q={dati.quadro} />
          <SegnaleCard segnale={dati.segnale} sizing={dati.sizing} avviso={dati.avviso} capitale={dati.capitale} rischioPct={dati.rischioPct} />
          <ComeMiMuovoCard scenari={dati.scenari} />
        </>
      )}

      <footer className="pt-4 pb-8 text-center text-xs text-neutral-600">
        questa è la mia lettura dei grafici, non un consiglio finanziario 🙏
      </footer>
    </main>
  );
}

function FonteBadge({ fonte, affidabile, ritardoMin }: { fonte: string; affidabile: boolean; ritardoMin: number }) {
  return (
    <div
      className={`rounded-lg px-3 py-2 text-xs ${
        affidabile ? "bg-neutral-900 text-neutral-400" : "bg-amber-950/50 text-amber-300 border border-amber-800"
      }`}
    >
      fonte: {fonte} · ultima candela {ritardoMin.toFixed(0)} min fa
    </div>
  );
}

function PrezzoCard({ q }: { q: Quadro }) {
  const chg = ((q.prezzo / q.dayOpen - 1) * 100).toFixed(2);
  return (
    <section className="rounded-xl bg-neutral-900 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-3xl font-semibold tabular-nums">{it(q.prezzo, 2)}</div>
        <div className={`text-sm font-medium ${Number(chg) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {Number(chg) >= 0 ? "+" : ""}
          {chg}% oggi
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400">
        <div>apertura {it(q.dayOpen, 2)}</div>
        <div>max {it(q.dayHi, 2)}</div>
        <div>ieri chiusura {it(q.prevClose, 2)}</div>
        <div>min {it(q.dayLo, 2)}</div>
      </div>
      <div className="flex gap-2 flex-wrap text-xs">
        <Badge label={`1h ${q.trend1h}`} tono={q.trend1h.startsWith("rialzista") ? "su" : q.trend1h.startsWith("ribassista") ? "giu" : "neutro"} />
        <Badge label={`15m ${q.trend15}`} tono={q.trend15 === "rialzista" ? "su" : "giu"} />
        <Badge label={`vwap ${it(q.vwap, 1)}`} tono={q.prezzo > q.vwap ? "su" : "giu"} />
      </div>
      <div className="text-xs text-neutral-500">atr 5m {q.atr5.toFixed(1)}$ · 15m {q.atr15.toFixed(1)}$ · 1h {q.atr1h.toFixed(1)}$</div>
    </section>
  );
}

function Badge({ label, tono }: { label: string; tono: "su" | "giu" | "neutro" }) {
  const colori =
    tono === "su"
      ? "bg-emerald-950 text-emerald-300 border-emerald-800"
      : tono === "giu"
        ? "bg-red-950 text-red-300 border-red-800"
        : "bg-neutral-800 text-neutral-300 border-neutral-700";
  return <span className={`rounded-full border px-2 py-1 ${colori}`}>{label}</span>;
}

function LivelliCard({ q }: { q: Quadro }) {
  return (
    <section className="rounded-xl bg-neutral-900 p-4 space-y-2">
      <h2 className="text-sm font-medium text-neutral-400 mb-1">i livelli da segnare</h2>
      <Riga colore="red" etichetta="resistenza chiave" valore={q.r2} />
      <Riga colore="red" etichetta="resistenza vicina" valore={q.r1} />
      <Riga colore="emerald" etichetta="supporto vicino" valore={q.s1} />
      <Riga colore="emerald" etichetta="supporto chiave" valore={q.s2} />
    </section>
  );
}

function Riga({ colore, etichetta, valore }: { colore: "red" | "emerald"; etichetta: string; valore: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-neutral-400">{etichetta}</span>
      <span className={`font-medium tabular-nums ${colore === "red" ? "text-red-400" : "text-emerald-400"}`}>{tondo(valore)}</span>
    </div>
  );
}

function SegnaleCard({
  segnale,
  sizing,
  avviso,
  capitale,
  rischioPct,
}: {
  segnale: Segnale;
  sizing: Sizing | null;
  avviso: string | null;
  capitale: number;
  rischioPct: number;
}) {
  if (segnale.lato === "ATTENDI") {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex items-center gap-2 text-neutral-300 font-medium">⏸ ATTENDI</div>
        <p className="mt-1 text-sm text-neutral-400">{segnale.motivo}</p>
        {avviso && <p className="mt-2 text-xs text-amber-400">{avviso}</p>}
      </section>
    );
  }
  const s = segnale.scenario!;
  const buy = segnale.lato === "BUY";
  return (
    <section className={`rounded-xl p-4 border ${buy ? "border-emerald-700 bg-emerald-950/30" : "border-red-700 bg-red-950/30"}`}>
      <div className={`flex items-center gap-2 font-semibold ${buy ? "text-emerald-400" : "text-red-400"}`}>
        {buy ? "🟢" : "🔴"} XAUUSD {segnale.lato}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-neutral-400">entrata</dt>
        <dd className="text-right tabular-nums">{it(s.entrata, 2)}</dd>
        <dt className="text-neutral-400">stop loss</dt>
        <dd className="text-right tabular-nums">{it(s.stop, 2)}</dd>
        <dt className="text-neutral-400">target 1</dt>
        <dd className="text-right tabular-nums">
          {it(s.t1, 2)} <span className="text-neutral-500">(rr {rr(s, s.t1).toFixed(1)})</span>
        </dd>
        <dt className="text-neutral-400">target 2</dt>
        <dd className="text-right tabular-nums">
          {it(s.t2, 2)} <span className="text-neutral-500">(rr {rr(s, s.t2).toFixed(1)})</span>
        </dd>
        {sizing && (
          <>
            <dt className="text-neutral-400">size</dt>
            <dd className="text-right tabular-nums">{sizing.lotti.toFixed(2)} lotti</dd>
            <dt className="text-neutral-400">rischio</dt>
            <dd className="text-right tabular-nums">
              {it(sizing.rischioUsd, 2)} usd ({sizing.rischioPct.toFixed(2)}%)
            </dd>
          </>
        )}
      </dl>
      <p className="mt-3 text-xs text-neutral-400">motivo: {segnale.motivo}</p>
      {avviso && <p className="mt-1 text-xs text-amber-400">{avviso}</p>}
      <p className="mt-2 text-xs text-neutral-500">
        a target 1 chiudi metà e porta lo stop a break-even. capitale {it(capitale)} usd, rischio impostato {rischioPct}%.
      </p>
    </section>
  );
}

function ComeMiMuovoCard({ scenari }: { scenari: [Scenario, Scenario, Scenario, Scenario] }) {
  const [rimb, , , srimb] = scenari;
  return (
    <section className="rounded-xl bg-neutral-900 p-4 space-y-3 text-sm">
      <h2 className="text-sm font-medium text-neutral-400">come mi muovo io (setup attivi: rimbalzo)</h2>
      <div>
        <span className="text-emerald-400 font-medium">long — </span>
        se {rimb.condizione}, entro con stop sotto {tondo(rimb.stop)} e target verso {tondo(rimb.t1)} e poi {tondo(rimb.t2)}.
      </div>
      <div>
        <span className="text-red-400 font-medium">short — </span>
        lo guardo solo se {srimb.condizione}. in quel caso entro con stop sopra {tondo(srimb.stop)} e target verso {tondo(srimb.t1)} e poi {tondo(srimb.t2)}.
      </div>
    </section>
  );
}
