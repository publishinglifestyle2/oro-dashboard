"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, ColorType, IChartApi, ISeriesApi, IPriceLine, CandlestickData, UTCTimestamp } from "lightweight-charts";

const INTERVALLO_MS = 60_000;
const SPREAD_STIMATO = 0.35; // stessa costante usata server-side: qui serve solo per l'anteprima live

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
  candeleGrafico: { time: number; open: number; high: number; low: number; close: number }[];
}
interface Operazione {
  id: number;
  lato: "BUY" | "SELL";
  entrata: number;
  stop: number;
  t1: number;
  t2: number;
  lotti: number;
  rischioUsd: number;
  motivo: string;
  apertaIl: string;
  stato: "aperta" | "chiusa";
  esito?: string;
  uscita?: number;
  r?: number;
  usd?: number;
  chiusaIl?: string;
}
interface RispostaOperazioni {
  ok: boolean;
  errore?: string;
  aperta: Operazione | null;
  storico: Operazione[];
}

const it = (x: number, dec = 0) => x.toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const tondo = (x: number) => Math.round(x);
const rr = (s: Scenario, target: number) => Math.abs(target - s.entrata) / Math.abs(s.entrata - s.stop);

type StatoNotifiche = "non-supportate" | "default" | "granted" | "denied";
type StatoPush = "controllo" | "non-supportate" | "richiede-installazione" | "da-attivare" | "attiva" | "errore";

// converte la chiave pubblica VAPID (base64 url-safe) nel formato che pushManager.subscribe si aspetta
function base64UrlAUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export default function Dashboard() {
  const [dati, setDati] = useState<RispostaApi | null>(null);
  const [operazioni, setOperazioni] = useState<RispostaOperazioni | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [caricando, setCaricando] = useState(true);
  const [ultimoFetch, setUltimoFetch] = useState<Date | null>(null);
  const [secondiProssimo, setSecondiProssimo] = useState(60);
  const [statoNotifiche, setStatoNotifiche] = useState<StatoNotifiche>("non-supportate");
  const [statoPush, setStatoPush] = useState<StatoPush>("controllo");
  const [azioneInCorso, setAzioneInCorso] = useState(false);
  const [erroreAzione, setErroreAzione] = useState<string | null>(null);
  // chiave dell'ultimo segnale già notificato: evita di far suonare la stessa operazione
  // a ogni giro di polling finché resta valida.
  const ultimoAvvisato = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setStatoNotifiche(Notification.permission as StatoNotifiche);
    }
  }, []);

  const chiediNotifiche = useCallback(() => {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then((esito) => setStatoNotifiche(esito as StatoNotifiche));
  }, []);

  // notifiche push vere (arrivano anche a telefono bloccato/app chiusa). su iPhone Apple le
  // permette SOLO se il sito è stato aggiunto alla schermata Home (non da una scheda Safari normale).
  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatoPush("non-supportate");
        return;
      }
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (iOS && !standalone) {
        setStatoPush("richiede-installazione");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.getSubscription();
        setStatoPush(sub ? "attiva" : "da-attivare");
      } catch {
        setStatoPush("errore");
      }
    })();
  }, []);

  const attivaPush = useCallback(async () => {
    try {
      const risp = await fetch("/api/push");
      const { publicKey } = await risp.json();
      if (!publicKey) {
        setStatoPush("errore");
        return;
      }
      const permesso = await Notification.requestPermission();
      if (permesso !== "granted") {
        setStatoPush("errore");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlAUint8Array(publicKey) as BufferSource,
      });
      await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ azione: "abbona", subscription: sub.toJSON() }),
      });
      setStatoPush("attiva");
    } catch {
      setStatoPush("errore");
    }
  }, []);

  const caricaOperazioni = useCallback(async () => {
    try {
      const res = await fetch("/api/operazioni", { cache: "no-store" });
      const json: RispostaOperazioni = await res.json();
      if (json.ok) setOperazioni(json);
    } catch {
      // silenzioso: il resto della dashboard funziona comunque senza il tracciamento manuale
    }
  }, []);

  const aggiorna = useCallback(async () => {
    try {
      const res = await fetch("/api/signal", { cache: "no-store" });
      const json: RispostaApi = await res.json();
      if (!json.ok) throw new Error(json.errore || "errore sconosciuto");
      setDati(json);
      setErrore(null);

      if (json.segnale.lato !== "ATTENDI" && json.segnale.scenario && Notification.permission === "granted") {
        const s = json.segnale.scenario;
        const chiave = `${json.segnale.lato}-${s.entrata}-${json.quadro.t}`;
        if (ultimoAvvisato.current !== chiave) {
          ultimoAvvisato.current = chiave;
          const icona = json.segnale.lato === "BUY" ? "🟢" : "🔴";
          new Notification(`${icona} XAUUSD ${json.segnale.lato}`, {
            body: `entrata ${it(s.entrata, 2)} · stop ${it(s.stop, 2)} · target ${it(s.t1, 2)} / ${it(s.t2, 2)}`,
            tag: "oro-segnale",
          });
        }
      }
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e));
    } finally {
      setCaricando(false);
      setUltimoFetch(new Date());
      setSecondiProssimo(60);
    }
    caricaOperazioni();
  }, [caricaOperazioni]);

  useEffect(() => {
    aggiorna();
    const id = setInterval(aggiorna, INTERVALLO_MS);
    return () => clearInterval(id);
  }, [aggiorna]);

  useEffect(() => {
    const id = setInterval(() => setSecondiProssimo((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, []);

  const apri = useCallback(
    async (lato: "BUY" | "SELL", entrata: number, stop: number, t1: number, t2: number, motivo: string) => {
      setAzioneInCorso(true);
      setErroreAzione(null);
      try {
        const res = await fetch("/api/operazioni", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ azione: "apri", lato, entrata, stop, t1, t2, motivo }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.errore || "errore nell'apertura");
        await caricaOperazioni();
      } catch (e) {
        setErroreAzione(e instanceof Error ? e.message : String(e));
      } finally {
        setAzioneInCorso(false);
      }
    },
    [caricaOperazioni]
  );

  const chiudi = useCallback(
    async (id: number, esito: string, uscita: number) => {
      setAzioneInCorso(true);
      setErroreAzione(null);
      try {
        const res = await fetch("/api/operazioni", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ azione: "chiudi", id, esito, uscita }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.errore || "errore nella chiusura");
        await caricaOperazioni();
      } catch (e) {
        setErroreAzione(e instanceof Error ? e.message : String(e));
      } finally {
        setAzioneInCorso(false);
      }
    },
    [caricaOperazioni]
  );

  const posizioneAperta = operazioni?.aperta ?? null;

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-6 space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">🟡 assistente oro</h1>
        <div className="text-right text-xs text-neutral-400">
          {ultimoFetch && <div>aggiornato {ultimoFetch.toLocaleTimeString("it-IT")}</div>}
          <div>prossimo tra {secondiProssimo}s · <button onClick={aggiorna} className="underline hover:text-amber-400">aggiorna ora</button></div>
        </div>
      </header>

      {statoNotifiche === "default" && (
        <button
          onClick={chiediNotifiche}
          className="w-full rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-300 hover:bg-amber-950/70 transition text-left"
        >
          🔔 attiva le notifiche pop-up — appena arriva un BUY/SELL te lo mostro anche a scheda
          minimizzata (tienila aperta in background sul browser)
        </button>
      )}
      {statoNotifiche === "denied" && (
        <div className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-xs text-neutral-500">
          notifiche bloccate dal browser — per riattivarle: impostazioni del sito → notifiche
        </div>
      )}

      {statoPush === "richiede-installazione" && (
        <div className="w-full rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-300">
          📱 per le notifiche push su iPhone (arrivano anche a telefono bloccato): tocca{" "}
          <span className="font-medium">Condividi</span> in Safari → <span className="font-medium">Aggiungi a Home</span>,
          poi apri l&apos;app dall&apos;icona sulla schermata Home invece che da Safari.
        </div>
      )}
      {statoPush === "da-attivare" && (
        <button
          onClick={attivaPush}
          className="w-full rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-300 hover:bg-amber-950/70 transition text-left"
        >
          📱 attiva le notifiche push sul telefono — arrivano anche ad app chiusa/telefono bloccato
        </button>
      )}
      {statoPush === "attiva" && (
        <div className="w-full rounded-lg border border-emerald-800 bg-emerald-950/30 px-4 py-2 text-xs text-emerald-400">
          📱 notifiche push attive su questo dispositivo
        </div>
      )}
      {statoPush === "errore" && (
        <div className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-xs text-neutral-500">
          non sono riuscito ad attivare le notifiche push (permesso negato o non supportato) — controlla nelle
          impostazioni del telefono che il sito/app abbia il permesso di inviare notifiche, poi{" "}
          <button onClick={() => window.location.reload()} className="underline hover:text-amber-400">
            ricarica la pagina
          </button>
        </div>
      )}

      {caricando && !dati && <div className="text-neutral-400">carico i dati…</div>}

      {errore && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          errore: {errore}
        </div>
      )}
      {erroreAzione && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {erroreAzione}
        </div>
      )}

      {dati && (
        <>
          <FonteBadge fonte={dati.fonte} affidabile={dati.affidabile} ritardoMin={dati.ritardoMin} />
          <PrezzoCard q={dati.quadro} />
          <GraficoCard candele={dati.candeleGrafico} q={dati.quadro} segnale={dati.segnale} posizioneAperta={posizioneAperta} />
          <LivelliCard q={dati.quadro} />

          {posizioneAperta ? (
            <PosizioneApertaCard op={posizioneAperta} prezzoAttuale={dati.quadro.prezzo} onChiudi={chiudi} bloccato={azioneInCorso} />
          ) : (
            <SegnaleCard
              segnale={dati.segnale}
              sizing={dati.sizing}
              avviso={dati.avviso}
              capitale={dati.capitale}
              rischioPct={dati.rischioPct}
              onApri={apri}
              bloccato={azioneInCorso}
            />
          )}

          {!posizioneAperta && <ComeMiMuovoCard scenari={dati.scenari} />}
          {operazioni && operazioni.storico.length > 0 && <StoricoCard storico={operazioni.storico} />}
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

function GraficoCard({
  candele,
  q,
  segnale,
  posizioneAperta,
}: {
  candele: { time: number; open: number; high: number; low: number; close: number }[];
  q: Quadro;
  segnale: Segnale;
  posizioneAperta: Operazione | null;
}) {
  const contenitoreRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const serieRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineeRef = useRef<IPriceLine[]>([]);

  // crea il grafico una sola volta
  useEffect(() => {
    if (!contenitoreRef.current) return;
    const chart = createChart(contenitoreRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#a3a3a3" },
      grid: { vertLines: { color: "#1f1f1f" }, horzLines: { color: "#1f1f1f" } },
      // prezzi a destra, come su TradingView. Per non far coprire le candele più recenti dalle
      // etichette dei livelli (che crescono verso sinistra dall'asse), lascio vuoto a destra
      // (rightOffset) lo spazio in cui possono espandersi senza sovrapporsi ai prezzi veri.
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#404040", rightOffset: 22 },
      rightPriceScale: { visible: true, borderColor: "#404040" },
      leftPriceScale: { visible: false },
      height: 280,
      width: contenitoreRef.current.clientWidth,
    });
    const serie = chart.addSeries(CandlestickSeries, {
      priceScaleId: "right",
      upColor: "#34d399",
      downColor: "#f87171",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
    });
    chartRef.current = chart;
    serieRef.current = serie;

    const ridimensiona = () => {
      if (contenitoreRef.current) chart.applyOptions({ width: contenitoreRef.current.clientWidth });
    };
    window.addEventListener("resize", ridimensiona);
    return () => {
      window.removeEventListener("resize", ridimensiona);
      chart.remove();
      chartRef.current = null;
      serieRef.current = null;
    };
  }, []);

  // aggiorna le candele a ogni giro
  useEffect(() => {
    if (!serieRef.current || candele.length === 0) return;
    serieRef.current.setData(candele as CandlestickData<UTCTimestamp>[]);
    chartRef.current?.timeScale().fitContent();
  }, [candele]);

  // ridisegna le linee (livelli + eventuale operazione/segnale) a ogni giro
  useEffect(() => {
    const serie = serieRef.current;
    if (!serie) return;
    lineeRef.current.forEach((l) => serie.removePriceLine(l));
    lineeRef.current = [];

    const linea = (price: number, color: string, title: string, tratteggiata = false) => {
      lineeRef.current.push(
        serie.createPriceLine({ price, color, lineWidth: 1, lineStyle: tratteggiata ? 2 : 0, axisLabelVisible: true, title })
      );
    };

    // i livelli vicini sono i trigger veri (rimbalzo sul supporto = entra buy, rifiuto sulla
    // resistenza = entra sell — vedi "come mi muovo io"); quelli chiave restano target di riferimento.
    linea(q.r1, "#f87171", "🔴 entra SELL");
    linea(q.r2, "#f87171", "target");
    linea(q.s1, "#34d399", "🟢 entra BUY");
    linea(q.s2, "#34d399", "target");

    if (posizioneAperta) {
      linea(posizioneAperta.entrata, "#f5c518", "entrata");
      linea(posizioneAperta.stop, "#ef4444", "stop", true);
      linea(posizioneAperta.t1, "#22c55e", "t1", true);
      linea(posizioneAperta.t2, "#22c55e", "t2", true);
    } else if (segnale.lato !== "ATTENDI" && segnale.scenario) {
      const s = segnale.scenario;
      linea(s.entrata, "#f5c518", "entrata");
      linea(s.stop, "#ef4444", "stop", true);
      linea(s.t1, "#22c55e", "t1", true);
      linea(s.t2, "#22c55e", "t2", true);
    }
  }, [q, segnale, posizioneAperta]);

  return (
    <section className="rounded-xl bg-neutral-900 p-4">
      <h2 className="text-sm font-medium text-neutral-400 mb-2">grafico live (1 minuto)</h2>
      <div ref={contenitoreRef} />
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
  onApri,
  bloccato,
}: {
  segnale: Segnale;
  sizing: Sizing | null;
  avviso: string | null;
  capitale: number;
  rischioPct: number;
  onApri: (lato: "BUY" | "SELL", entrata: number, stop: number, t1: number, t2: number, motivo: string) => Promise<void>;
  bloccato: boolean;
}) {
  const [mostraForm, setMostraForm] = useState(false);
  const [prezzoInserito, setPrezzoInserito] = useState("");

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

      {!mostraForm ? (
        <button
          onClick={() => {
            setPrezzoInserito(s.entrata.toFixed(2));
            setMostraForm(true);
          }}
          className={`mt-4 w-full rounded-lg py-2 text-sm font-medium transition ${
            buy ? "bg-emerald-700 hover:bg-emerald-600" : "bg-red-700 hover:bg-red-600"
          } text-white`}
        >
          ✅ sono entrato
        </button>
      ) : (
        <div className="mt-4 rounded-lg bg-black/30 p-3 space-y-2">
          <label className="text-xs text-neutral-400">a quale prezzo sei entrato davvero?</label>
          <input
            type="number"
            step="0.01"
            value={prezzoInserito}
            onChange={(e) => setPrezzoInserito(e.target.value)}
            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-1.5 text-sm tabular-nums outline-none focus:border-amber-500"
          />
          <div className="flex gap-2">
            <button
              disabled={bloccato}
              onClick={async () => {
                const entrataReale = parseFloat(prezzoInserito);
                if (!Number.isFinite(entrataReale)) return;
                await onApri(segnale.lato as "BUY" | "SELL", entrataReale, s.stop, s.t1, s.t2, segnale.motivo);
                setMostraForm(false);
              }}
              className="flex-1 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm py-1.5"
            >
              conferma
            </button>
            <button onClick={() => setMostraForm(false)} className="rounded-md border border-neutral-700 px-3 text-sm text-neutral-400 hover:bg-neutral-800">
              annulla
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PosizioneApertaCard({
  op,
  prezzoAttuale,
  onChiudi,
  bloccato,
}: {
  op: Operazione;
  prezzoAttuale: number;
  onChiudi: (id: number, esito: string, uscita: number) => Promise<void>;
  bloccato: boolean;
}) {
  const buy = op.lato === "BUY";
  const segno = buy ? 1 : -1;
  const rischio = Math.abs(op.entrata - op.stop);
  const rLive = rischio ? (segno * (prezzoAttuale - op.entrata) - SPREAD_STIMATO) / rischio : 0;
  const usdLive = rLive * op.rischioUsd;

  const toccatoStop = buy ? prezzoAttuale <= op.stop : prezzoAttuale >= op.stop;
  const raggiuntoT2 = buy ? prezzoAttuale >= op.t2 : prezzoAttuale <= op.t2;
  const raggiuntoT1 = buy ? prezzoAttuale >= op.t1 : prezzoAttuale <= op.t1;

  let suggerimento: { testo: string; tono: "rosso" | "verde" | "neutro" };
  if (toccatoStop) suggerimento = { testo: `🛑 il prezzo ha toccato il tuo stop (${it(op.stop, 2)}) — se non sei già uscito, valuta di farlo`, tono: "rosso" };
  else if (raggiuntoT2) suggerimento = { testo: `🎯🎯 hai raggiunto il target 2 (${it(op.t2, 2)}) — valuta la chiusura completa`, tono: "verde" };
  else if (raggiuntoT1) suggerimento = { testo: `🎯 hai raggiunto il target 1 (${it(op.t1, 2)}) — chiudi metà e porta lo stop a break-even (${it(op.entrata, 2)})`, tono: "verde" };
  else suggerimento = { testo: `in corso: ${rLive >= 0 ? "+" : ""}${rLive.toFixed(2)}R (~${usdLive >= 0 ? "+" : ""}${it(usdLive, 2)} usd non realizzati)`, tono: "neutro" };

  const bottoni: { etichetta: string; esito: string; uscita: number }[] = [
    { etichetta: `🎯 T1 (${it(op.t1, 2)})`, esito: "target 1", uscita: op.t1 },
    { etichetta: `🎯 T2 (${it(op.t2, 2)})`, esito: "target 2", uscita: op.t2 },
    { etichetta: `🛑 stop (${it(op.stop, 2)})`, esito: "stop", uscita: op.stop },
    { etichetta: `✋ a mercato (${it(prezzoAttuale, 2)})`, esito: "manuale", uscita: prezzoAttuale },
  ];

  return (
    <section className={`rounded-xl p-4 border ${buy ? "border-emerald-700 bg-emerald-950/30" : "border-red-700 bg-red-950/30"}`}>
      <div className={`flex items-center gap-2 font-semibold ${buy ? "text-emerald-400" : "text-red-400"}`}>
        {buy ? "🟢" : "🔴"} posizione aperta — XAUUSD {op.lato}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-neutral-400">entrata (tua)</dt>
        <dd className="text-right tabular-nums">{it(op.entrata, 2)}</dd>
        <dt className="text-neutral-400">stop loss</dt>
        <dd className="text-right tabular-nums">{it(op.stop, 2)}</dd>
        <dt className="text-neutral-400">target 1 / 2</dt>
        <dd className="text-right tabular-nums">{it(op.t1, 2)} / {it(op.t2, 2)}</dd>
        <dt className="text-neutral-400">size</dt>
        <dd className="text-right tabular-nums">{op.lotti.toFixed(2)} lotti</dd>
      </dl>

      <div
        className={`mt-3 rounded-lg px-3 py-2 text-sm ${
          suggerimento.tono === "rosso"
            ? "bg-red-950/60 text-red-300"
            : suggerimento.tono === "verde"
              ? "bg-emerald-950/60 text-emerald-300"
              : "bg-black/30 text-neutral-300"
        }`}
      >
        {suggerimento.testo}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        {bottoni.map((b) => (
          <button
            key={b.esito}
            disabled={bloccato}
            onClick={() => onChiudi(op.id, b.esito, b.uscita)}
            className="rounded-md border border-neutral-700 py-2 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
          >
            {b.etichetta}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-neutral-500">aperta il {new Date(op.apertaIl).toLocaleString("it-IT")}</p>
    </section>
  );
}

function StoricoCard({ storico }: { storico: Operazione[] }) {
  return (
    <section className="rounded-xl bg-neutral-900 p-4 space-y-2">
      <h2 className="text-sm font-medium text-neutral-400 mb-1">storico operazioni</h2>
      {storico.map((op) => (
        <div key={op.id} className="flex items-center justify-between text-sm border-t border-neutral-800 pt-2 first:border-0 first:pt-0">
          <div className="text-neutral-400">
            <span className={op.lato === "BUY" ? "text-emerald-400" : "text-red-400"}>{op.lato}</span>{" "}
            {it(op.entrata, 2)} → {op.uscita != null ? it(op.uscita, 2) : "?"}{" "}
            <span className="text-neutral-600">({op.esito})</span>
          </div>
          <div className={`tabular-nums font-medium ${(op.r ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {op.r != null ? `${op.r >= 0 ? "+" : ""}${op.r.toFixed(2)}R` : "—"}
            {op.usd != null && (
              <span className="text-neutral-500 font-normal"> ({op.usd >= 0 ? "+" : ""}{it(op.usd, 2)} usd)</span>
            )}
          </div>
        </div>
      ))}
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
