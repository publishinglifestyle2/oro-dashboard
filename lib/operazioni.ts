// tracciamento manuale: tu clicchi "sono entrato" (con il prezzo vero a cui sei entrato,
// non necessariamente quello suggerito) e poi "chiudi" quando esci. Il resto (R, usd) si calcola
// da solo, con la stessa formula usata ovunque nel sistema (oro.py / bot/monitor.py).
import { getSql } from "./db";

export const SPREAD_STIMATO = 0.35;

export interface Operazione {
  id: number;
  lato: "BUY" | "SELL";
  entrata: number;
  stop: number;
  t1: number;
  t2: number;
  lotti: number;
  rischioUsd: number;
  motivo: string;
  apertaIl: string;
  stato: "aperta" | "chiusa";
  esito?: string;
  uscita?: number;
  r?: number;
  usd?: number;
  chiusaIl?: string;
}

type RigaGrezza = Record<string, unknown> & {
  aperta_il: string | Date;
  chiusa_il: string | Date | null;
};

function riga(r: RigaGrezza): Operazione {
  return {
    id: r.id as number,
    lato: r.lato as "BUY" | "SELL",
    entrata: Number(r.entrata),
    stop: Number(r.stop),
    t1: Number(r.t1),
    t2: Number(r.t2),
    lotti: Number(r.lotti),
    rischioUsd: Number(r.rischio_usd),
    motivo: (r.motivo as string) ?? "",
    apertaIl: r.aperta_il instanceof Date ? r.aperta_il.toISOString() : r.aperta_il,
    stato: r.stato as "aperta" | "chiusa",
    esito: (r.esito as string) ?? undefined,
    uscita: r.uscita != null ? Number(r.uscita) : undefined,
    r: r.r != null ? Number(r.r) : undefined,
    usd: r.usd != null ? Number(r.usd) : undefined,
    chiusaIl: r.chiusa_il ? (r.chiusa_il instanceof Date ? r.chiusa_il.toISOString() : r.chiusa_il) : undefined,
  };
}

export async function operazioneAperta(): Promise<Operazione | null> {
  const sql = getSql();
  const righe = (await sql`select * from operazioni where stato = 'aperta' order by id desc limit 1`) as RigaGrezza[];
  return righe.length ? riga(righe[0]) : null;
}

export async function storicoOperazioni(limite = 15): Promise<Operazione[]> {
  const sql = getSql();
  const righe = (await sql`select * from operazioni where stato = 'chiusa' order by chiusa_il desc limit ${limite}`) as RigaGrezza[];
  return righe.map(riga);
}

export async function apriOperazione(dati: {
  lato: "BUY" | "SELL";
  entrata: number;
  stop: number;
  t1: number;
  t2: number;
  lotti: number;
  rischioUsd: number;
  motivo: string;
}): Promise<Operazione> {
  const giaAperta = await operazioneAperta();
  if (giaAperta) throw new Error("c'è già una posizione aperta: chiudila prima di aprirne un'altra");
  const sql = getSql();
  const righe = (await sql`
    insert into operazioni (lato, entrata, stop, t1, t2, lotti, rischio_usd, motivo)
    values (${dati.lato}, ${dati.entrata}, ${dati.stop}, ${dati.t1}, ${dati.t2}, ${dati.lotti}, ${dati.rischioUsd}, ${dati.motivo})
    returning *
  `) as RigaGrezza[];
  return riga(righe[0]);
}

export async function chiudiOperazione(id: number, esito: string, uscita: number): Promise<Operazione> {
  const sql = getSql();
  const righe = (await sql`select * from operazioni where id = ${id} and stato = 'aperta'`) as RigaGrezza[];
  if (!righe.length) throw new Error("operazione non trovata o già chiusa");
  const op = riga(righe[0]);
  const segno = op.lato === "BUY" ? 1 : -1;
  const rischio = Math.abs(op.entrata - op.stop);
  const r = rischio ? (segno * (uscita - op.entrata) - SPREAD_STIMATO) / rischio : 0;
  const usd = r * op.rischioUsd;
  const aggiornate = (await sql`
    update operazioni
    set stato = 'chiusa', esito = ${esito}, uscita = ${uscita}, r = ${r}, usd = ${usd}, chiusa_il = now()
    where id = ${id}
    returning *
  `) as RigaGrezza[];
  return riga(aggiornate[0]);
}
