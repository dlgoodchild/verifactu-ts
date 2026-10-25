import { DefaultWaitSeconds, FlowControl, MaxRecordsPerBatch, toBatches } from '~/flow-control'

const at = (iso: string) => new Date(iso)

describe('FlowControl', () => {
  test('starts at AEAT\'s 60 seconds, and lets the first submission go at once', () => {
    const flow = new FlowControl()

    expect(flow.wait).toBe(DefaultWaitSeconds)
    expect(flow.lastSent).toBeNull()
    expect(flow.delayMs(1, at('2024-01-01T10:00:00Z'))).toBe(0)
    expect(flow.canSend(1)).toBe(true)
  })

  test('makes the next submission wait until the time AEAT asked for has passed since the last', () => {
    const flow = new FlowControl()
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), 60)

    expect(flow.delayMs(5, at('2024-01-01T10:00:20Z'))).toBe(40_000)
    expect(flow.delayMs(5, at('2024-01-01T10:01:00Z'))).toBe(0)
    expect(flow.delayMs(5, at('2024-01-01T10:05:00Z'))).toBe(0)
    expect(flow.canSend(5, at('2024-01-01T10:00:20Z'))).toBe(false)
    expect(flow.canSend(5, at('2024-01-01T10:01:00Z'))).toBe(true)
  })

  test('lets a full batch go without waiting, however recent the last submission', () => {
    const flow = new FlowControl()
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), 60)

    expect(flow.delayMs(MaxRecordsPerBatch, at('2024-01-01T10:00:01Z'))).toBe(0)
    expect(flow.delayMs(MaxRecordsPerBatch + 50, at('2024-01-01T10:00:01Z'))).toBe(0)
    expect(flow.delayMs(MaxRecordsPerBatch - 1, at('2024-01-01T10:00:01Z'))).toBe(59_000)
  })

  test('follows the wait in AEAT\'s latest answer', () => {
    const flow = new FlowControl()
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), 120)
    expect(flow.wait).toBe(120)
    expect(flow.delayMs(1, at('2024-01-01T10:01:00Z'))).toBe(60_000)

    flow.recordSubmission(at('2024-01-01T10:03:00Z'), 30)
    expect(flow.wait).toBe(30)
  })

  test('keeps the wait when an answer gives none or nonsense, and takes a wait of zero', () => {
    const flow = new FlowControl({ waitSeconds: 45 })
    flow.recordSubmission(at('2024-01-01T10:00:00Z'))
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), NaN)
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), -5)
    expect(flow.wait).toBe(45)

    flow.recordSubmission(at('2024-01-01T10:00:00Z'), 0)
    expect(flow.wait).toBe(0)
    expect(flow.delayMs(1, at('2024-01-01T10:00:00Z'))).toBe(0)
  })

  test('can start from saved state, after a restart', () => {
    const flow = new FlowControl({ waitSeconds: 90, lastSentAt: at('2024-01-01T10:00:00Z') })

    expect(flow.delayMs(3, at('2024-01-01T10:00:30Z'))).toBe(60_000)
  })

  test('has nothing to wait for when there is nothing to send', () => {
    const flow = new FlowControl()
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), 60)

    expect(flow.delayMs(0, at('2024-01-01T10:00:01Z'))).toBe(0)
    expect(flow.canSend(0)).toBe(false)
  })

  test('says when the next submission can go', () => {
    const flow = new FlowControl()
    flow.recordSubmission(at('2024-01-01T10:00:00Z'), 60)

    expect(flow.nextSendAt(2, at('2024-01-01T10:00:10Z')).toISOString()).toBe('2024-01-01T10:01:00.000Z')
    expect(flow.nextSendAt(2, at('2024-01-01T10:02:00Z')).toISOString()).toBe('2024-01-01T10:02:00.000Z')
  })

  test('can use another batch limit', () => {
    const flow = new FlowControl({ lastSentAt: at('2024-01-01T10:00:00Z') }, 10)

    expect(flow.delayMs(10, at('2024-01-01T10:00:01Z'))).toBe(0)
    expect(flow.delayMs(9, at('2024-01-01T10:00:01Z'))).toBe(59_000)
  })
})

describe('toBatches', () => {
  test('splits in order into batches of at most 1000', () => {
    const batches = toBatches(Array.from({ length: 2500 }, (_, index) => index))

    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 500])
    expect(batches[0][0]).toBe(0)
    expect(batches[2][499]).toBe(2499)
  })

  test('gives one batch for fewer, and none for nothing', () => {
    expect(toBatches([1, 2, 3])).toEqual([[1, 2, 3]])
    expect(toBatches([])).toEqual([])
  })

  test('can use another size, but not nonsense', () => {
    expect(toBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(() => toBatches([1], 0)).toThrow(RangeError)
    expect(() => toBatches([1], 1.5)).toThrow(RangeError)
  })
})
