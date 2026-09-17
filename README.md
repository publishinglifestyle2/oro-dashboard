# assistente oro — dashboard live

Dashboard web per XAU/USD: apri la pagina e vedi il segnale **ricalcolato sul momento** (entrata,
stop, target 1, target 2, size al rischio impostato), aggiornato da solo ogni minuto mentre la
tieni aperta. Nessun Telegram.

Dati in tempo reale da **TradingView Premium** (via un piccolo Pine Script + webhook), con OANDA
o Yahoo come ripiego se il database non è ancora popolato. Stessa logica del bot locale in
`~/Desktop/LUCAT` (porting da Python a TypeScript, stesse regole).

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

## da dove arrivano i dati (in ordine di priorità)

1. **TradingView** — un Pine Script sul grafico OANDA:XAUUSD manda una candela a 1 minuto a un
   webhook del sito ogni volta che chiude. Le candele si accumulano in un piccolo database
   (Neon Postgres, gratuito) e il motore le ricampiona in 5m/15m/1h a ogni richiesta. Se il
   database ha abbastanza storico, è questa la fonte usata.
2. **OANDA** — se il database non è ancora pronto e `OANDA_TOKEN` è impostato.
3. **Yahoo GC=F** — ripiego finale, sempre disponibile ma con ritardo e prezzo sfasato: non per operare.

## struttura

```
lib/candele.ts             tipi e numeri di base: ema, atr, pivot, cluster livelli, fuso orario italiano
lib/motore.ts               quadro, scenari, trigger, size — stesse regole del bot Python
lib/db.ts                   connessione Neon (inizializzazione pigra, non rompe il build)
lib/tvdb.ts                  legge le candele ricevute da TradingView e le ricampiona
lib/oanda.ts / lib/yahoo.ts  fonti di ripiego
app/api/signal/               l'unica API che il sito interroga: ricalcola tutto e risponde in json
app/api/webhook/tradingview/  qui TradingView manda le candele (protetto da TV_WEBHOOK_SECRET)
app/page.tsx                  la dashboard, interroga /api/signal ogni 60 secondi
proxy.ts                      protezione con passcode (facoltativa, tramite DASHBOARD_PASSCODE)
pine/luca-oro-feed-1m.pine    lo script da caricare su TradingView
scripts/seed.ts               popola il database con lo storico già esportato (data/xauusd_1m.csv)
```

## configurazione — 4 passaggi

### 1. Collega il database (Neon, gratuito)

Su Vercel: **Storage → Create Database → Neon** (o `vercel integration add neon` da CLI). Si
collega da solo, scrive `DATABASE_URL` nelle variabili d'ambiente del progetto.

### 2. Genera la chiave del webhook

Una stringa lunga a caso, es. `openssl rand -hex 24`. Mettila su Vercel come `TV_WEBHOOK_SECRET`.

### 3. Popola lo storico

In locale, con `DATABASE_URL` in `.env.local` (su Vercel: Settings → Environment Variables → copia
il valore, oppure `vercel env pull .env.local`):

```bash
npm run seed
```

Legge `data/xauusd_1m.csv` (già incluso, ~25.000 candele) e riempie il database: così il sito
parte subito con settimane di storico invece di aspettare che i webhook lo accumulino da zero.

### 4. Collega TradingView

1. Apri un grafico **OANDA:XAUUSD**, timeframe **1 minuto**, candele standard
2. Incolla lo script [`pine/luca-oro-feed-1m.pine`](pine/luca-oro-feed-1m.pine) nel Pine Editor e applicalo al grafico
3. Crea un **Alert**: condizione = il nome dello script, "Once Per Bar Close"
4. Nel campo **Webhook URL** metti:
   ```
   https://TUO-SITO.vercel.app/api/webhook/tradingview?key=LA_TUA_TV_WEBHOOK_SECRET
   ```
5. Lascia l'alert attivo — il messaggio lo compone da solo lo script, non serve scriverlo

Da qui in poi il database si aggiorna da solo, minuto per minuto, finché l'alert resta attivo e
TradingView resta aperto (o con l'alert impostato su "aperto" nelle preferenze del tuo piano).

## altre variabili d'ambiente

| nome | default | note |
|---|---|---|
| `OANDA_TOKEN` | — | ripiego se il database non è pronto (facoltativo) |
| `CAPITALE` | `950` | usd |
| `RISCHIO_PCT` | `2` | percentuale per operazione |
| `DASHBOARD_PASSCODE` | — | se impostata, la pagina chiede questa parola prima di mostrare capitale e segnali |

## sviluppo locale

```bash
npm install
npm run dev
```

## deploy

Import del repo GitHub su vercel.com/new, poi i 4 passaggi sopra.
