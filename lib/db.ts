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
