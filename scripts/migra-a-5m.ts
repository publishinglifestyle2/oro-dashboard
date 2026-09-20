/**
 * da lanciare UNA VOLTA SOLA quando il database torna accessibile (dopo aver risolto la quota
 * Neon), per non perdere lo storico raccolto finché si scriveva in candele_1m: lo ricampiona a
 * 5 minuti e lo travasa in candele_5m, la tabella che ora usa il webhook (vedi lib/tvdb.ts).
 *
 * uso:
 *   npx dotenv -e .env.local -- npx tsx scripts/migra-a-5m.ts
 */
import { neon } from "@neondatabase/serverless";
import { ricampiona } from "../lib/candele";
import { assicuraSchemaCandele5m } from "../lib/db";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("manca DATABASE_URL: lancia con `npx dotenv -e .env.local -- npx tsx scripts/migra-a-5m.ts`");
    process.exit(1);
  }
  await assicuraSchemaCandele5m();
  const sql = neon(process.env.DATABASE_URL);

  const righe = (await sql`select t, open, high, low, close, volume from candele_1m order by t asc`) as {
    t: string | number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  console.log(`${righe.length} candele 1m trovate, ricampiono a 5 minuti...`);
  if (righe.length === 0) {
    console.log("niente da migrare.");
    return;
  }

  const m1 = righe.map((r) => ({
    time: Number(r.t),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    completa: true,
  }));
  const m5 = ricampiona(m1, 300_000);
  console.log(`${m5.length} candele 5m ottenute, inserisco...`);

  const LOTTO = 500;
  for (let i = 0; i < m5.length; i += LOTTO) {
    const blocco = m5.slice(i, i + LOTTO);
    const valori: string[] = [];
    const parametri: number[] = [];
    blocco.forEach((c, k) => {
      const base = k * 6;
      valori.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      parametri.push(c.time, c.open, c.high, c.low, c.close, c.volume);
    });
    const query = `
      insert into candele_5m (t, open, high, low, close, volume)
      values ${valori.join(",")}
      on conflict (t) do update set
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
    `;
    await sql.query(query, parametri);
    process.stdout.write(`\r${Math.min(i + LOTTO, m5.length)}/${m5.length}`);
  }
  console.log("\nfatto. candele_1m resta intatta (non viene toccata), candele_5m ora ha lo storico.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
