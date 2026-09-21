/**
 * semina candele_5m con SOLO gli ultimi N giorni del CSV storico (non tutto lo storico da 25.000
 * righe) — è quanto basta al motore (pivot su 10-12 giorni, vedi lib/motore.ts), niente di più.
 * Pensato per il nuovo database (dopo che il primo ha esaurito la quota), per ripartire snelli.
 *
 * uso:
 *   npx dotenv -e .env.local -- npx tsx scripts/seed-minimo.ts data/xauusd_1m.csv 14
 */
import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { ricampiona } from "../lib/candele";

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
  const giorni = parseFloat(process.argv[3] || "14");
  if (!process.env.DATABASE_URL) {
    console.error("manca DATABASE_URL: lancia con `npx dotenv -e .env.local -- npx tsx scripts/seed-minimo.ts`");
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);

  const testo = readFileSync(path, "utf8").trim().split("\n");
  const intestazione = rigaCsv(testo[0]);
  const idx = (nome: string) => intestazione.findIndex((c) => c.toLowerCase() === nome.toLowerCase());
  const iTime = idx("time"), iOpen = idx("open"), iHigh = idx("high"), iLow = idx("low"), iClose = idx("close"), iVol = idx("Volume");

  const m1: { time: number; open: number; high: number; low: number; close: number; volume: number; completa: true }[] = [];
  let ultimoT = 0;
  for (let i = 1; i < testo.length; i++) {
    const c = rigaCsv(testo[i]);
    if (c.length < 5) continue;
    const t = Date.parse(c[iTime]);
    if (!Number.isFinite(t)) continue;
    ultimoT = Math.max(ultimoT, t);
    m1.push({ time: t, open: +c[iOpen], high: +c[iHigh], low: +c[iLow], close: +c[iClose], volume: iVol >= 0 ? +c[iVol] || 0 : 0, completa: true });
  }
  const soglia = ultimoT - giorni * 86_400_000;
  const m1Filtrate = m1.filter((c) => c.time >= soglia);
  console.log(`csv: ${m1.length} candele 1m totali, tenute le ultime ${giorni} giorni: ${m1Filtrate.length} candele`);

  const m5 = ricampiona(m1Filtrate, 300_000);
  console.log(`ricampionate a 5 minuti: ${m5.length} candele — inserisco...`);

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
  console.log("\nfatto.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
