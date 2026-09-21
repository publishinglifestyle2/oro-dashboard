// tracciamento manuale: tu clicchi "sono entrato" (con il prezzo vero a cui sei entrato,
// non necessariamente quello suggerito) e poi "chiudi" quando esci, anche tu con il prezzo vero
// a cui sei uscito. Stop/target restano modificabili mentre la posizione è aperta (es. sposti lo
// stop a break-even), ma il calcolo di R/usd alla chiusura usa sempre il rischio ORIGINALE con
// cui la size è stata dimensionata — stessa formula testata di oro.py / bot/monitor.py.
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
  rischioOriginale: number;
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
    rischioOriginale: Number(r.rischio_originale ?? Math.abs(Number(r.entrata) - Number(r.stop))),
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
  apertaIl?: string; // iso, per registrare un'entrata manuale a un orario diverso da adesso
}): Promise<Operazione> {
  const giaAperta = await operazioneAperta();
  if (giaAperta) throw new Error("c'è già una posizione aperta: chiudila prima di aprirne un'altra");
  const sql = getSql();
  const rischioOriginale = Math.abs(dati.entrata - dati.stop);
  const righe = (
    dati.apertaIl
      ? await sql`
          insert into operazioni (lato, entrata, stop, t1, t2, lotti, rischio_usd, rischio_originale, motivo, aperta_il)
          values (${dati.lato}, ${dati.entrata}, ${dati.stop}, ${dati.t1}, ${dati.t2}, ${dati.lotti}, ${dati.rischioUsd}, ${rischioOriginale}, ${dati.motivo}, ${dati.apertaIl})
          returning *
        `
      : await sql`
          insert into operazioni (lato, entrata, stop, t1, t2, lotti, rischio_usd, rischio_originale, motivo)
          values (${dati.lato}, ${dati.entrata}, ${dati.stop}, ${dati.t1}, ${dati.t2}, ${dati.lotti}, ${dati.rischioUsd}, ${rischioOriginale}, ${dati.motivo})
          returning *
        `
  ) as RigaGrezza[];
  return riga(righe[0]);
}

/** cambia stop/target di una posizione già aperta (es. stop a break-even dopo il target 1).
 * il rischio_originale con cui è stata dimensionata la size NON viene mai toccato qui: R/usd
 * alla chiusura restano corretti anche se lo stop visualizzato è cambiato. */
export async function modificaOperazione(id: number, dati: { stop?: number; t1?: number; t2?: number }): Promise<Operazione> {
  const sql = getSql();
  const righe = (await sql`select * from operazioni where id = ${id} and stato = 'aperta'`) as RigaGrezza[];
  if (!righe.length) throw new Error("operazione non trovata o già chiusa");
  const attuale = riga(righe[0]);
  const stop = dati.stop ?? attuale.stop;
  const t1 = dati.t1 ?? attuale.t1;
  const t2 = dati.t2 ?? attuale.t2;
  const aggiornate = (await sql`
    update operazioni set stop = ${stop}, t1 = ${t1}, t2 = ${t2} where id = ${id} returning *
  `) as RigaGrezza[];
  return riga(aggiornate[0]);
}

/** corregge un'operazione GIÀ CHIUSA (es. un dato inserito sbagliato) e ricalcola R/usd sui
 * valori aggiornati, con la stessa formula di chiudiOperazione. Se cambi entrata o stop, il
 * rischio_originale si ricalcola di conseguenza (stai correggendo un fatto, non spostando uno
 * stop in corsa). Lotti e rischio_usd (la size) restano quelli con cui hai aperto: correggere un
 * prezzo non ridimensiona la posizione. */
export async function modificaStorico(
  id: number,
  dati: { lato?: "BUY" | "SELL"; entrata?: number; stop?: number; t1?: number; t2?: number; uscita?: number; esito?: string }
): Promise<Operazione> {
  const sql = getSql();
  const righe = (await sql`select * from operazioni where id = ${id} and stato = 'chiusa'`) as RigaGrezza[];
  if (!righe.length) throw new Error("operazione non trovata o non ancora chiusa");
  const attuale = riga(righe[0]);

  const lato = dati.lato ?? attuale.lato;
  const entrata = dati.entrata ?? attuale.entrata;
  const stop = dati.stop ?? attuale.stop;
  const t1 = dati.t1 ?? attuale.t1;
  const t2 = dati.t2 ?? attuale.t2;
  const uscita = dati.uscita ?? attuale.uscita ?? entrata;
  const esito = dati.esito ?? attuale.esito ?? "manuale";

  const rischioOriginale = Math.abs(entrata - stop);
  const segno = lato === "BUY" ? 1 : -1;
  const r = rischioOriginale ? (segno * (uscita - entrata) - SPREAD_STIMATO) / rischioOriginale : 0;
  const usd = r * attuale.rischioUsd;

  const aggiornate = (await sql`
    update operazioni
    set lato = ${lato}, entrata = ${entrata}, stop = ${stop}, t1 = ${t1}, t2 = ${t2},
        rischio_originale = ${rischioOriginale}, uscita = ${uscita}, esito = ${esito}, r = ${r}, usd = ${usd}
    where id = ${id}
    returning *
  `) as RigaGrezza[];
  return riga(aggiornate[0]);
}

/** cancella un'operazione (aperta o chiusa) dallo storico — es. una registrata per sbaglio. */
export async function eliminaOperazione(id: number): Promise<void> {
  const sql = getSql();
  await sql`delete from operazioni where id = ${id}`;
}

export async function chiudiOperazione(id: number, esito: string, uscita: number): Promise<Operazione> {
  const sql = getSql();
  const righe = (await sql`select * from operazioni where id = ${id} and stato = 'aperta'`) as RigaGrezza[];
  if (!righe.length) throw new Error("operazione non trovata o già chiusa");
  const op = riga(righe[0]);
  const segno = op.lato === "BUY" ? 1 : -1;
  // stessa formula di oro.py/bot/monitor.py: rischio_originale, MAI lo stop attuale (che puoi
  // aver spostato con "modifica") — altrimenti spostare lo stop a break-even falserebbe R.
  const r = op.rischioOriginale ? (segno * (uscita - op.entrata) - SPREAD_STIMATO) / op.rischioOriginale : 0;
  const usd = r * op.rischioUsd;
  const aggiornate = (await sql`
    update operazioni
    set stato = 'chiusa', esito = ${esito}, uscita = ${uscita}, r = ${r}, usd = ${usd}, chiusa_il = now()
    where id = ${id}
    returning *
  `) as RigaGrezza[];
  return riga(aggiornate[0]);
}
