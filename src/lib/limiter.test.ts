import { describe, expect, it } from 'vitest'
import { limiter } from './limiter'

/** A job that finishes when told to, recording when it started. */
function deferred(log: string[], name: string) {
  let finish: () => void = () => {}
  let fail: (err: Error) => void = () => {}
  const job = () => {
    log.push(name)
    return new Promise<string>((resolve, reject) => {
      finish = () => resolve(name)
      fail = reject
    })
  }
  return { job, finish: () => finish(), fail: (err: Error) => fail(err) }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('limiter', () => {
  it('never runs more than its slots at once, and runs everything', async () => {
    const limit = limiter(3)
    let running = 0
    let most = 0
    const jobs = Array.from({ length: 20 }, (_, i) =>
      limit.run(async () => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, (i * 7) % 5))
        running--
        return i
      }),
    )
    expect(limit.running).toBe(3)
    expect(limit.waiting).toBe(17)
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    await settle()
    expect(most).toBe(3)
    expect(limit.running).toBe(0)
    expect(limit.waiting).toBe(0)
  })

  it('starts waiting jobs by priority, then in the order they came', async () => {
    const limit = limiter(1)
    const log: string[] = []
    const first = deferred(log, 'first')
    const rest = ['late', 'soon', 'later', 'soon too'].map((name) => deferred(log, name))
    void limit.run(first.job)
    const priorities = [5, 1, 9, 1]
    rest.forEach((d, i) => void limit.run(d.job, priorities[i]))
    for (const d of [first, rest[1], rest[3], rest[0]]) {
      d.finish()
      await settle()
    }
    expect(log).toEqual(['first', 'soon', 'soon too', 'late', 'later'])
  })

  it('moves a waiting job up when it is needed sooner', async () => {
    const limit = limiter(1)
    const log: string[] = []
    const busy = deferred(log, 'busy')
    const a = deferred(log, 'a')
    const b = deferred(log, 'b')
    void limit.run(busy.job)
    void limit.run(a.job, 10, 'a')
    void limit.run(b.job, 20, 'b')
    limit.raise('b', 0)
    // Raising never pushes a job back.
    limit.raise('a', 50)
    busy.finish()
    await settle()
    expect(log).toEqual(['busy', 'b'])
  })

  it('frees the slot of a job that fails, and passes the failure on', async () => {
    const limit = limiter(1)
    const log: string[] = []
    const bad = deferred(log, 'bad')
    const good = deferred(log, 'good')
    const failed = limit.run(bad.job)
    const done = limit.run(good.job)
    bad.fail(new Error('no decoder'))
    await expect(failed).rejects.toThrow('no decoder')
    await settle()
    expect(log).toEqual(['bad', 'good'])
    good.finish()
    expect(await done).toBe('good')
    // A job that throws before it even returns a promise counts as failed too.
    await expect(
      limit.run(() => {
        throw new Error('sync')
      }),
    ).rejects.toThrow('sync')
    expect(limit.running).toBe(0)
  })
})
