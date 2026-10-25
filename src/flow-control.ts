/**
 * AEAT's flow control for submissions (article 16.2 of Order HAC/1177/2024): after each submission AEAT says how many
 * seconds to wait (`TiempoEsperaEnvio`, 60 at first). The next submission may be made when that time has passed since
 * the previous one, **or** as soon as as many records are waiting as a submission can hold (1000), whichever is first.
 *
 * This class holds that state. It does no waiting itself: it says how long to wait, and the caller sleeps, so it works
 * in a job, a loop or a test with a fake clock. Keep one per taxpayer (the wait is per sender), and persist
 * `waitSeconds` and `lastSentAt` if the process can restart.
 */

export const DefaultWaitSeconds = 60
export const MaxRecordsPerBatch = 1000

export class FlowControl {
  private waitSeconds: number
  private lastSentAt: Date | null

  constructor(
    initial: { waitSeconds?: number, lastSentAt?: Date | null } = {},
    private readonly maxRecords: number = MaxRecordsPerBatch
  ) {
    this.waitSeconds = initial.waitSeconds ?? DefaultWaitSeconds
    this.lastSentAt = initial.lastSentAt ?? null
  }

  /** Seconds AEAT last asked to wait between submissions */
  get wait(): number {
    return this.waitSeconds
  }

  /** When the last submission was made, if any */
  get lastSent(): Date | null {
    return this.lastSentAt
  }

  /** Records the outcome of a submission: when it was sent and the wait AEAT answered with */
  recordSubmission(sentAt: Date, waitSeconds?: number): void {
    this.lastSentAt = sentAt
    if (waitSeconds !== undefined && Number.isFinite(waitSeconds) && waitSeconds >= 0) {
      this.waitSeconds = waitSeconds
    }
  }

  /** Milliseconds to wait before sending `pending` records; 0 when a submission can go now */
  delayMs(pending: number, now: Date = new Date()): number {
    if (pending <= 0) return 0
    if (pending >= this.maxRecords || this.lastSentAt === null) return 0
    return Math.max(0, this.lastSentAt.getTime() + this.waitSeconds * 1000 - now.getTime())
  }

  /** Whether `pending` records can be sent now */
  canSend(pending: number, now: Date = new Date()): boolean {
    return pending > 0 && this.delayMs(pending, now) === 0
  }

  /** The earliest moment `pending` records may be sent (`now` if already allowed) */
  nextSendAt(pending: number, now: Date = new Date()): Date {
    return new Date(now.getTime() + this.delayMs(pending, now))
  }
}

/** Splits records into submissions of at most `size` records, keeping their order (which is the chain order) */
export function toBatches<T>(items: readonly T[], size: number = MaxRecordsPerBatch): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('A batch holds at least one record')
  }
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }
  return batches
}
