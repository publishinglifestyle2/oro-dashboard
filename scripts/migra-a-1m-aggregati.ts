/**
 * migrazione una tantum verso l'architettura "1 minuto vivo + aggregati 15m/1h": vedi le note in
 * lib/tvdb.ts e app/api/webhook/tradingview/route.ts sul perché.
 *
 * - candele_15m_agg / candele_1h_agg: ricostruite ricampionando TUTTO lo storico di candele_5m
 *   (funziona anche se una parte di quello storico è in realtà già a 1 minuto — vedi sotto —
 *   perché ricampiona() raggruppa per timestamp, non assume una spaziatura fissa).
 * - candele_1m: copiata dalla coda di candele_5m che è già a risoluzione 1 minuto vera (dal
 *   20/09 22:04 in poi, quando l'alert su TradingView è passato a 1 minuto).
 *
 * uso: npx dotenv -e .env.local -- npx tsx scripts/migra-a-1m-aggregati.ts
 */
import { neon } from "@neondatabase/serverless";
import { ricampiona, Candela } from "../lib/candele";
import { assicuraSchema, assicuraSchemaAggregati } from "../lib/db";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("manca DATABASE_URL: lancia con `npx dotenv -e .env.local -- npx tsx scripts/migra-a-1m-aggregati.ts`");
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  await assicuraSchema();
  await assicuraSchemaAggregati();

  const righe = (await sql`select t, open, high, low, close, volume from candele_5m order by t asc`) as {
    t: string | number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  console.log(`candele_5m: ${righe.length} righe`);
  const grezze: Candela[] = righe.map((r) => ({
    time: Number(r.t),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    completa: true,
  }));

  async function inserisci(tabella: "candele_15m_agg" | "candele_1h_agg", candele: Candela[]) {
    const LOTTO = 500;
    for (let i = 0; i < candele.length; i += LOTTO) {
      const blocco = candele.slice(i, i + LOTTO);
      const valori: string[] = [];
      const parametri: number[] = [];
      blocco.forEach((c, k) => {
        const base = k * 6;
        valori.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
        parametri.push(c.time, c.open, c.high, c.low, c.close, c.volume);
      });
      await sql.query(
        `insert into ${tabella} (t, open, high, low, close, volume)
         values ${valori.join(",")}
         on conflict (t) do update set
           open = excluded.open, high = excluded.high, low = excluded.low,
           close = excluded.close, volume = excluded.volume`,
        parametri
      );
      process.stdout.write(`\r${tabella}: ${Math.min(i + LOTTO, candele.length)}/${candele.length}`);
    }
    console.log("");
  }

  const m15 = ricampiona(grezze, 900_000);
  const h1 = ricampiona(grezze, 3_600_000);
  console.log(`ricampionate: ${m15.length} candele 15m, ${h1.length} candele 1h — inserisco...`);
  await inserisci("candele_15m_agg", m15);
  await inserisci("candele_1h_agg", h1);

  // coda già a 1 minuto vero (vedi nota sopra): la copio così com'è in candele_1m.
  const SOGLIA_1M = Date.parse("2026-09-20T22:04:00Z");
  const codaM1 = grezze.filter((c) => c.time >= SOGLIA_1M);
  console.log(`candele_1m: copio la coda già a 1 minuto (${codaM1.length} righe da ${new Date(SOGLIA_1M).toISOString()})...`);
  const LOTTO = 500;
  for (let i = 0; i < codaM1.length; i += LOTTO) {
    const blocco = codaM1.slice(i, i + LOTTO);
    const valori: string[] = [];
    const parametri: number[] = [];
    blocco.forEach((c, k) => {
      const base = k * 6;
      valori.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      parametri.push(c.time, c.open, c.high, c.low, c.close, c.volume);
    });
    await sql.query(
      `insert into candele_1m (t, open, high, low, close, volume)
       values ${valori.join(",")}
       on conflict (t) do update set
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume`,
      parametri
    );
    process.stdout.write(`\rcandele_1m: ${Math.min(i + LOTTO, codaM1.length)}/${codaM1.length}`);
  }
  console.log("\nfatto.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
