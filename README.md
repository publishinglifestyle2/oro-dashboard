# assistente oro — dashboard live

Dashboard web per XAU/USD: apri la pagina e vedi il segnale **ricalcolato sul momento** sui dati
freschi (entrata, stop, target 1, target 2, size al rischio impostato), aggiornato da solo ogni
minuto mentre la tieni aperta. Nessun Telegram, nessun database: tutto si ricalcola a ogni richiesta.

Stessa logica del bot locale in `~/Desktop/LUCAT` (porting da Python a TypeScript, stesse regole),
qui pensata per girare gratis su Vercel.

## come ragiona

1. **Quadro**: trend a 1 ora e 15 minuti (EMA), ATR, VWAP di giornata, 2 resistenze + 2 supporti
   (pivot sulle candele + estremi di oggi/ieri).
2. **Bias**: compra solo se il trend a 1h è rialzista *e* il prezzo è sopra il VWAP; vende solo
   nel caso opposto. Altrimenti aspetta.
3. **Trigger**: solo su candele a 5 minuti **concluse** — rimbalzo deciso su un livello nella
   direzione del bias (le rotture sono disattivate di default, nel backtest perdevano).
4. **Size**: rischio massimo impostato (default 2%) diviso per la distanza dello stop.

Non tiene una posizione demo aperta tra un aggiornamento e l'altro (a differenza del bot locale):
ogni volta dice "cosa direbbe il motore adesso", punto. Per lo storico/registro vedi il bot locale.

## struttura

```
lib/candele.ts     tipi e numeri di base: ema, atr, pivot, cluster livelli, fuso orario italiano
lib/oanda.ts        candele 1h/15m/5m dal conto OANDA (consigliato)
lib/yahoo.ts        ripiego senza account: future GC=F, ricampionato dal minuto
lib/motore.ts       quadro, scenari, trigger, size — stesse regole del bot Python
app/api/signal/     l'unica API: ricalcola tutto e risponde in json
app/page.tsx         la dashboard, interroga /api/signal ogni 60 secondi
proxy.ts             protezione con passcode (facoltativa, tramite DASHBOARD_PASSCODE)
```

## variabili d'ambiente (su Vercel: Settings → Environment Variables)

| nome | default | note |
|---|---|---|
| `OANDA_TOKEN` | — | conto practice gratuito, "Manage API Access". Senza, usa Yahoo (non per operare) |
| `OANDA_ENV` | `practice` | o `live` |
| `CAPITALE` | `950` | usd |
| `RISCHIO_PCT` | `2` | percentuale per operazione |
| `DASHBOARD_PASSCODE` | — | se impostata, la pagina chiede questa parola prima di mostrare capitale e segnali |

## sviluppo locale

```bash
npm install
npm run dev
```

## deploy

Vedi le istruzioni che l'assistente ti ha dato in chat: import del repo GitHub su vercel.com/new,
imposta le variabili d'ambiente, deploy.
