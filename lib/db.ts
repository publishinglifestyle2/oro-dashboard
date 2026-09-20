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

/** candele a 5 minuti dal webhook TradingView (versione "gratuita": una candela ogni 5 minuti
 * invece che ogni minuto, così il database si riaddormenta tra una chiamata e l'altra invece di
 * restare sveglio 24/7 — è quello che consumava la quota gratuita di Neon in ~2 giorni). */
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
