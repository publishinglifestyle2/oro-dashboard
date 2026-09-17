/**
 * semina il database con lo storico 1 minuto già esportato da TradingView, così il sito parte
 * subito con settimane di storico invece di aspettare che i webhook lo accumulino da zero.
 *
 * uso:
 *   npx dotenv -e .env.local -- npx tsx scripts/seed.ts data/xauusd_1m.csv
 */
import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { assicuraSchema } from "../lib/db";

/** split CSV minimale ma corretto sulle virgolette: il file ha un campo diagnostico tra
 * virgolette con una virgola dentro ("diagnostica setup: 1 rimbalzo, 2 breakout, 3 short"),
 * uno split ingenuo su "," sfaserebbe tutte le colonne dopo di esso (Volume compreso). */
function rigaCsv(riga: string): string[] {
  const campi: string[] = [];
  let corrente = "";
  let dentroVirgolette = false;
  for (const ch of riga) {
    if (ch === '"') dentroVirgolette = !dentroVirgolette;
    else if (ch === "," && !dentroVirgolette) {
      campi.push(corrente);
      corrente = "";
    } else corrente += ch;
  }
  campi.push(corrente);
  return campi;
}

async function main() {
  const path = process.argv[2] || "data/xauusd_1m.csv";
  if (!process.env.DATABASE_URL) {
    console.error("manca DATABASE_URL: lancia con `npx dotenv -e .env.local -- npx tsx scripts/seed.ts`");
    process.exit(1);
  }
  await assicuraSchema();
  const sql = neon(process.env.DATABASE_URL);

  const testo = readFileSync(path, "utf8").trim().split("\n");
  const intestazione = rigaCsv(testo[0]);
  const idx = (nome: string) => intestazione.findIndex((c) => c.toLowerCase() === nome.toLowerCase());
  const iTime = idx("time"), iOpen = idx("open"), iHigh = idx("high"), iLow = idx("low"), iClose = idx("close"), iVol = idx("Volume");
  if ([iTime, iOpen, iHigh, iLow, iClose].some((i) => i < 0)) {
    console.error("intestazione csv inattesa, colonne trovate:", intestazione);
    process.exit(1);
  }

  const righe: [number, number, number, number, number, number][] = [];
  for (let i = 1; i < testo.length; i++) {
    const c = rigaCsv(testo[i]);
    if (c.length < 5) continue;
    const t = Date.parse(c[iTime]);
    if (!Number.isFinite(t)) continue;
    righe.push([t, +c[iOpen], +c[iHigh], +c[iLow], +c[iClose], iVol >= 0 ? +c[iVol] || 0 : 0]);
  }
  console.log(`${righe.length} candele da inserire da ${path}`);

  const LOTTO = 500;
  for (let i = 0; i < righe.length; i += LOTTO) {
    const blocco = righe.slice(i, i + LOTTO);
    const valori: string[] = [];
    const parametri: number[] = [];
    blocco.forEach((r, k) => {
      const base = k * 6;
      valori.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      parametri.push(...r);
    });
    const query = `
      insert into candele_1m (t, open, high, low, close, volume)
      values ${valori.join(",")}
      on conflict (t) do update set
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
    `;
    await sql.query(query, parametri);
    process.stdout.write(`\r${Math.min(i + LOTTO, righe.length)}/${righe.length}`);
  }
  console.log("\nfatto.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
