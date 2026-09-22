import { neon } from "@neondatabase/serverless";

// inizializzazione pigra: se DATABASE_URL non è ancora impostata (es. primo deploy prima di
// collegare Neon) il build non deve rompersi — l'errore arriva solo se qualcuno chiama getSql().
let _sql: ReturnType<typeof neon> | null = null;

export function getSql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL non impostata");
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

/** candele grezze a 1 minuto ricevute dal webhook TradingView (luca-oro-feed-1m.pine) — la
 * fonte "viva". Per tenere sotto controllo il trasferimento dati di Neon (la stessa quota
 * esaurita in ~3 giorni quando giravamo a 1 minuto la prima volta) qui teniamo SOLO una finestra
 * recente: il contesto lungo (10 giorni per i pivot 1h, 3 giorni per i pivot 15m) vive nelle
 * tabelle aggregate sotto, aggiornate un pezzo alla volta — mai riletto da capo. */
export async function assicuraSchema() {
  const sql = getSql();
  await sql`
    create table if not exists candele_1m (
      t bigint primary key,
      open double precision not null,
      high double precision not null,
      low double precision not null,
      close double precision not null,
      volume double precision not null default 0,
      ricevuto_at timestamptz not null default now()
    )
  `;
}

/** candele 15 minuti e 1 ora, aggregate in incrementale (un upsert per candela 1m ricevuta, mai
 * ricostruite rileggendo lo storico grezzo): è quello che tiene economico l'accesso ai 10 giorni
 * di storico che servono ai livelli, anche restando a 1 minuto sulla fonte viva. */
export async function assicuraSchemaAggregati() {
  const sql = getSql();
  await sql`
    create table if not exists candele_15m_agg (
      t bigint primary key,
      open double precision not null,
      high double precision not null,
      low double precision not null,
      close double precision not null,
      volume double precision not null default 0
    )
  `;
  await sql`
    create table if not exists candele_1h_agg (
      t bigint primary key,
      open double precision not null,
      high double precision not null,
      low double precision not null,
      close double precision not null,
      volume double precision not null default 0
    )
  `;
}

/** @deprecated tabella della vecchia fase "5 minuti" (2026-09 → 22): non più scritta, lasciata
 * per lo storico già raccolto. Le funzioni sopra la sostituiscono. */
export async function assicuraSchemaCandele5m() {
  const sql = getSql();
  await sql`
    create table if not exists candele_5m (
      t bigint primary key,
      open double precision not null,
      high double precision not null,
      low double precision not null,
      close double precision not null,
      volume double precision not null default 0,
      ricevuto_at timestamptz not null default now()
    )
  `;
}

export async function assicuraSchemaOperazioni() {
  const sql = getSql();
  await sql`
    create table if not exists operazioni (
      id serial primary key,
      lato text not null,
      entrata double precision not null,
      stop double precision not null,
      t1 double precision not null,
      t2 double precision not null,
      lotti double precision not null,
      rischio_usd double precision not null,
      motivo text,
      aperta_il timestamptz not null default now(),
      stato text not null default 'aperta',
      esito text,
      uscita double precision,
      r double precision,
      usd double precision,
      chiusa_il timestamptz
    )
  `;
  // fissato all'apertura, mai toccato da "modifica": stop/t1/t2 restano modificabili liberamente
  // (es. sposti lo stop a break-even) senza che questo alteri il calcolo di R alla chiusura, che
  // deve restare "quante volte il rischio con cui hai dimensionato la size", non uno nuovo.
  await sql`alter table operazioni add column if not exists rischio_originale double precision`;
  await sql`update operazioni set rischio_originale = abs(entrata - stop) where rischio_originale is null`;
}

export async function assicuraSchemaPush() {
  const sql = getSql();
  await sql`
    create table if not exists abbonamenti_push (
      endpoint text primary key,
      p256dh text not null,
      auth text not null,
      creato_il timestamptz not null default now()
    )
  `;
  // riga unica: tiene traccia dell'ultimo segnale già notificato via push, per non rimandare
  // la stessa notifica a ogni candela finché il segnale resta lo stesso.
  await sql`
    create table if not exists push_stato (
      id int primary key default 1,
      ultima_chiave text
    )
  `;
  await sql`insert into push_stato (id, ultima_chiave) values (1, null) on conflict (id) do nothing`;
}
