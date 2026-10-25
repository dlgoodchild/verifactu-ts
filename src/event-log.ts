import fs from 'fs'
import path from 'path'
import type { EventType, IssuedByOther } from '~/codes'
import { eventRecordXml } from '~/event-xml'
import { createEventRecord, eventLinkOf, type EventData, type EventLink, type EventRecord, type Moment } from '~/events'
import { VerifactuConfigurationError, VerifactuError } from '~/errors'
import { signEventRecord, type RecordSigner } from '~/sign'
import type { Party, SoftwareSystem, Taxpayer } from '~/types'

/**
 * The event log of a non-VERI*FACTU system: creates, chains, signs and stores event records. See the README, "The two
 * ways to comply" and "The event log". VERI*FACTU systems do not need one.
 *
 * Where the events go is up to you:
 * - Pass `onEvent` and the log hands you every event to save wherever you like (a database table, a file store...).
 * - Pass nothing and the library appends each event to a flat file, one JSON object per line (`file`).
 */

/** One logged event: what a store keeps */
export interface EventLogEntry {
  /** The event record, signed */
  record: EventRecord
  /** The signed `RegistroEvento` XML, the form AEAT receives when events are exported */
  xml: string
}

export interface EventLogOptions {
  /** The taxpayer the software is used for (`ObligadoEmision`) */
  taxpayer: Taxpayer
  /** Your software (`SistemaInformatico`) */
  system: SoftwareSystem
  /** Signs every event (events must be signed); see `createSigner` */
  signer: RecordSigner
  /**
   * Called with each new event, to be saved durably before it returns. If it throws, the event does not count as
   * logged: the chain does not advance and `log` throws the same error. Needs `previous`. Cannot be used with `file`.
   */
  onEvent?: (entry: EventLogEntry) => void | Promise<void>
  /**
   * With `onEvent`: the last event you have saved (`eventLinkOf(record)`), or `null` if there is none yet. Required, so
   * that a restart cannot start a second chain by mistake.
   */
  previous?: EventLink | null
  /** Without `onEvent`: the flat file to append to (default `verifactu-event-log.jsonl` in the working directory) */
  file?: string
  /** The clock (default `new Date()`) */
  now?: () => Date
}

/** What `log` takes: an event record without what the log fills in */
export interface LogEventInput {
  type: EventType
  data?: EventData
  otherData?: string
  issuedBy?: IssuedByOther
  thirdParty?: Party
  /** When it happened (default now) */
  generatedAt?: Moment
}

export const DefaultEventLogFile = 'verifactu-event-log.jsonl'

export class EventLog {
  /** The flat file in use, when there is no `onEvent` */
  readonly file?: string
  private last: EventLink | null
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(private readonly options: EventLogOptions, file: string | undefined, last: EventLink | null) {
    this.file = file
    this.last = last
  }

  /** Opens the log. With the flat file, reads where the chain ends; with `onEvent`, uses `previous`. */
  static async open(options: EventLogOptions): Promise<EventLog> {
    if (options.onEvent) {
      if (options.file !== undefined) throw new VerifactuConfigurationError('Give `onEvent` or `file`, not both: `onEvent` replaces the flat file')
      if (options.previous === undefined) {
        throw new VerifactuConfigurationError('With `onEvent`, say where the chain ends with `previous` (the last event you saved, or null if there is none): otherwise a restart could start a second chain')
      }
      return new EventLog(options, undefined, options.previous)
    }
    if (options.previous !== undefined) throw new VerifactuConfigurationError('`previous` is only for `onEvent`: the flat file records where the chain ends')
    const file = path.resolve(options.file ?? DefaultEventLogFile)
    const entries = await readLastEntry(file)
    return new EventLog(options, file, entries ? eventLinkOf(entries.record) : null)
  }

  /** The link of the last event logged, or null if none */
  get lastEvent(): EventLink | null {
    return this.last
  }

  /**
   * Logs an event: creates, chains and signs it, saves it, and returns it. Calls are queued, so events from different
   * parts of the program are logged one after another in the order of the calls and stay in one chain.
   */
  log(input: LogEventInput): Promise<EventLogEntry> {
    const run = this.queue.then(() => this.append(input))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Logs event 01: the software started operating as a non-VERI*FACTU system */
  start(otherData?: string): Promise<EventLogEntry> {
    return this.log({ type: '01', otherData })
  }

  /** Logs event 02: the software stopped operating as a non-VERI*FACTU system */
  stop(otherData?: string): Promise<EventLogEntry> {
    return this.log({ type: '02', otherData })
  }

  /** Logs event 90: anything else worth recording. Say what happened in `description` (at most 100 characters). */
  other(description: string): Promise<EventLogEntry> {
    return this.log({ type: '90', otherData: description })
  }

  private async append(input: LogEventInput): Promise<EventLogEntry> {
    const now = this.options.now ?? (() => new Date())
    const created = createEventRecord({
      type: input.type,
      taxpayer: this.options.taxpayer,
      system: this.options.system,
      generatedAt: input.generatedAt ?? now(),
      data: input.data,
      otherData: input.otherData,
      issuedBy: input.issuedBy,
      thirdParty: input.thirdParty
    }, this.last)
    const record = await signEventRecord(created, this.options.signer, { signingTime: now() })
    const entry: EventLogEntry = { record, xml: eventRecordXml(record) }

    if (this.options.onEvent) await this.options.onEvent(entry)
    else await appendLine(this.file!, entry)

    this.last = eventLinkOf(record)
    return entry
  }
}

async function appendLine(file: string, entry: EventLogEntry): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.promises.open(file, 'a')
  try {
    await handle.write(`${JSON.stringify(entry)}\n`)
    await handle.sync()
  }
  finally {
    await handle.close()
  }
}

function parseEntry(line: string, file: string): EventLogEntry {
  try {
    const entry = JSON.parse(line) as EventLogEntry
    if (entry?.record?.kind !== 'evento' || typeof entry.xml !== 'string') throw new Error('not an event entry')
    return entry
  }
  catch {
    throw new VerifactuError(`The event log ${file} holds an entry that cannot be read. It was damaged, or the last write was cut short. Do not carry on logging into it; restore it from a backup or move it aside and investigate.`)
  }
}

/** Reads the last entry of a flat event log, without reading all of a large file; null if the file is missing or empty */
async function readLastEntry(file: string): Promise<EventLogEntry | null> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, 'r')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const { size } = await handle.stat()
    let chunk = 64 * 1024
    while (size > 0) {
      const length = Math.min(chunk, size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      const text = buffer.toString('utf8').replace(/\n+$/, '')
      const newline = text.lastIndexOf('\n')
      if (newline >= 0 || length === size) return text === '' ? null : parseEntry(text.slice(newline + 1), file)
      chunk *= 4
    }
    return null
  }
  finally {
    await handle.close()
  }
}

/** Reads every entry of a flat event log, in order (to export, check or show them). A missing file gives none. */
export async function readEventLogFile(file: string): Promise<EventLogEntry[]> {
  let content: string
  try {
    content = await fs.promises.readFile(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return content.split('\n').filter((line) => line.trim() !== '').map((line) => parseEntry(line, file))
}
