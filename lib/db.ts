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
