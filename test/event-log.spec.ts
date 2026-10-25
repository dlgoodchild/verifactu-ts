import fs from 'fs'
import os from 'os'
import path from 'path'
import { VerifactuConfigurationError, VerifactuError } from '~/errors'
import { DefaultEventLogFile, EventLog, readEventLogFile, type EventLogEntry } from '~/event-log'
import { eventLinkOf, verifyEventChain } from '~/events'
import { createSigner } from '~/sign'
import { verifySignature } from '~/verify-signature'
import { IssuerNif, makeSigningCertificate, pfxOf, system } from '@/helper/verifactu.helper'

const { authority, leaf } = makeSigningCertificate()
const signer = createSigner({ pfx: pfxOf(leaf, [authority.cert], 'secret'), passphrase: 'secret' })
const taxpayer = { name: 'Dave Goodchild', nif: IssuerNif }

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verifactu-event-log-'))
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

/** A clock that moves on a minute each time it is read */
function clock(start = '2024-03-01T10:00:00Z') {
  let time = new Date(start).getTime()
  return () => {
    const now = new Date(time)
    time += 60_000
    return now
  }
}

const fileLog = (file: string, now = clock()) => EventLog.open({ taxpayer, system, signer, file, now })

describe('the flat file (no callback)', () => {
  test('appends each event as a line of JSON holding the signed record and its XML', async () => {
    const file = path.join(directory, 'events.jsonl')
    const log = await fileLog(file)

    const started = await log.start()
    const stopped = await log.stop()

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(JSON.parse(JSON.stringify(started)))
    expect(started.record).toMatchObject({ type: '01', chaining: { first: true } })
    expect(stopped.record).toMatchObject({ type: '02', chaining: { previous: eventLinkOf(started.record) } })
    expect(started.xml).toContain('<sf:RegistroEvento xmlns:sf=')
    expect(verifySignature(started.xml).problems).toEqual([])
    expect(verifySignature(stopped.xml).problems).toEqual([])
  })

  test('makes the folder if it is not there', async () => {
    const file = path.join(directory, 'a', 'b', 'events.jsonl')

    await (await fileLog(file)).start()

    expect(fs.existsSync(file)).toBe(true)
  })

  test('carries on the chain after a restart, by reading the last entry of the file', async () => {
    const file = path.join(directory, 'events.jsonl')
    const first = await (await fileLog(file)).start()

    const restarted = await fileLog(file, clock('2024-03-02T10:00:00Z'))
    const next = await restarted.other('Backup tested')

    expect(restarted.lastEvent).toEqual(eventLinkOf(next.record))
    expect(next.record.chaining).toEqual({ previous: eventLinkOf(first.record) })
    expect(verifyEventChain((await readEventLogFile(file)).map((entry) => entry.record))).toEqual([])
  })

  test('starts a new chain in a new file, and reads an empty file as new', async () => {
    const file = path.join(directory, 'events.jsonl')
    fs.writeFileSync(file, '')

    const log = await fileLog(file)

    expect(log.lastEvent).toBeNull()
    expect((await log.start()).record.chaining).toEqual({ first: true })
  })

  test('finds the end of a long file without reading it all (a last entry larger than the first read)', async () => {
    const file = path.join(directory, 'events.jsonl')
    const log = await fileLog(file)
    await log.start()
    const big = await log.log({ type: '90', otherData: 'x'.repeat(100) })
    fs.appendFileSync(file, `${JSON.stringify({ ...big, padding: 'p'.repeat(300_000) })}\n`)

    const reopened = await fileLog(file)

    expect(reopened.lastEvent).toEqual(eventLinkOf(big.record))
  })

  test('uses the default file name in the working directory when none is given', async () => {
    const previous = process.cwd()
    process.chdir(directory)
    try {
      const log = await EventLog.open({ taxpayer, system, signer })
      await log.start()
      expect(fs.realpathSync(log.file!)).toBe(fs.realpathSync(path.join(directory, DefaultEventLogFile)))
    }
    finally {
      process.chdir(previous)
    }
  })

  test('refuses to carry on into a file whose last entry is damaged', async () => {
    const file = path.join(directory, 'events.jsonl')
    await (await fileLog(file)).start()
    fs.appendFileSync(file, '{"record": {"kind": "ev')

    await expect(fileLog(file)).rejects.toThrow(VerifactuError)
    await expect(fileLog(file)).rejects.toThrow('cannot be read')
  })

  test('reads every entry back in order, and nothing from a missing file', async () => {
    const file = path.join(directory, 'events.jsonl')
    const log = await fileLog(file)
    await log.start()
    await log.other('one')
    await log.stop()

    const entries = await readEventLogFile(file)

    expect(entries.map((entry) => entry.record.type)).toEqual(['01', '90', '02'])
    expect(await readEventLogFile(path.join(directory, 'missing.jsonl'))).toEqual([])
  })

  test('refuses `previous`, which only goes with a callback', async () => {
    await expect(EventLog.open({ taxpayer, system, signer, file: path.join(directory, 'e.jsonl'), previous: null })).rejects.toThrow(VerifactuConfigurationError)
  })
})

describe('the callback', () => {
  test('is handed every event, signed, with its XML, and nothing is written to a file', async () => {
    const entries: EventLogEntry[] = []
    const log = await EventLog.open({ taxpayer, system, signer, previous: null, onEvent: (entry) => { entries.push(entry) }, now: clock() })

    await log.start()
    await log.log({ type: '08', data: { kind: 'billing-export', periodStart: '2024-03-01T00:00:00+01:00', periodEnd: '2024-03-31T23:59:59+01:00', first: { issuerNif: IssuerNif, number: '1', issueDate: '2024-03-01', hash: 'A'.repeat(64) }, last: { issuerNif: IssuerNif, number: '9', issueDate: '2024-03-31', hash: 'B'.repeat(64) }, altaCount: 9, totalTax: 21, totalAmount: 121, cancellationCount: 0, noLongerKept: false } })

    expect(entries.map((entry) => entry.record.type)).toEqual(['01', '08'])
    expect(entries[1].record.chaining).toEqual({ previous: eventLinkOf(entries[0].record) })
    expect(entries.every((entry) => verifySignature(entry.xml).valid)).toBe(true)
    expect(log.file).toBeUndefined()
    expect(fs.readdirSync(directory)).toEqual([])
  })

  test('continues from the event you say was the last you saved', async () => {
    const seen: EventLogEntry[] = []
    const first = await (await EventLog.open({ taxpayer, system, signer, previous: null, onEvent: (entry) => { seen.push(entry) } })).start()

    const log = await EventLog.open({ taxpayer, system, signer, previous: eventLinkOf(first.record), onEvent: (entry) => { seen.push(entry) } })
    const next = await log.stop()

    expect(next.record.chaining).toEqual({ previous: eventLinkOf(first.record) })
    expect(verifyEventChain(seen.map((entry) => entry.record))).toEqual([])
  })

  test('has to be told where the chain ends, so a restart cannot start a second chain by mistake', async () => {
    await expect(EventLog.open({ taxpayer, system, signer, onEvent: () => undefined })).rejects.toThrow('previous')
  })

  test('cannot be combined with the flat file', async () => {
    await expect(EventLog.open({ taxpayer, system, signer, previous: null, file: path.join(directory, 'e.jsonl'), onEvent: () => undefined })).rejects.toThrow('not both')
  })

  test('when it fails, the event is not logged: the error comes back and the chain does not move', async () => {
    let fail = true
    const saved: EventLogEntry[] = []
    const log = await EventLog.open({
      taxpayer, system, signer, previous: null,
      onEvent: (entry) => {
        if (fail) throw new Error('database down')
        saved.push(entry)
      }
    })

    await expect(log.start()).rejects.toThrow('database down')
    expect(log.lastEvent).toBeNull()

    fail = false
    const retried = await log.start()

    expect(retried.record.chaining).toEqual({ first: true })
    expect(saved).toHaveLength(1)
  })

  test('waits for an asynchronous callback before the next event is created', async () => {
    const order: string[] = []
    const log = await EventLog.open({
      taxpayer, system, signer, previous: null, now: clock(),
      onEvent: async (entry) => {
        order.push(`start ${entry.record.type}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push(`end ${entry.record.type}`)
      }
    })

    await Promise.all([log.start(), log.other('second'), log.stop()])

    expect(order).toEqual(['start 01', 'end 01', 'start 90', 'end 90', 'start 02', 'end 02'])
  })
})

describe('logging', () => {
  test('events logged at the same time stay in one chain, in the order of the calls', async () => {
    const file = path.join(directory, 'events.jsonl')
    const log = await fileLog(file)

    await Promise.all(Array.from({ length: 10 }, (_, index) => log.other(`event ${index}`)))

    const records = (await readEventLogFile(file)).map((entry) => entry.record)
    expect(records.map((record) => record.otherData)).toEqual(Array.from({ length: 10 }, (_, index) => `event ${index}`))
    expect(verifyEventChain(records)).toEqual([])
  })

  test('uses the time given for an event, or the clock', async () => {
    const file = path.join(directory, 'events.jsonl')
    const log = await fileLog(file, clock('2024-03-01T10:00:00Z'))

    const clocked = await log.start()
    const given = await log.log({ type: '02', generatedAt: '2024-03-01T12:00:00+01:00' })

    expect(clocked.record.generatedAt).toBe('2024-03-01T11:00:00+01:00')
    expect(given.record.generatedAt).toBe('2024-03-01T12:00:00+01:00')
  })

  test('carries the third party and the other data, and refuses an event that is wrong without logging it', async () => {
    const file = path.join(directory, 'events.jsonl')
    const log = await fileLog(file)

    const entry = await log.log({ type: '90', otherData: 'Support session', issuedBy: 'T', thirdParty: { name: 'Gestoría', nif: 'B12345674' } })
    await expect(log.log({ type: '03' })).rejects.toThrow('data')

    expect(entry.record).toMatchObject({ issuedBy: 'T', thirdParty: { name: 'Gestoría', nif: 'B12345674' }, otherData: 'Support session' })
    expect((await readEventLogFile(file))).toHaveLength(1)
    expect(log.lastEvent).toEqual(eventLinkOf(entry.record))
  })
})
