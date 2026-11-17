/**
 * Runs async jobs at most `slots` at a time. Waiting jobs start lowest
 * `priority` first, then in the order they came; a waiting job that has a key
 * can be moved up later with `raise`. A job that fails frees its slot like any
 * other, and its promise rejects as it would have.
 */
export function limiter(slots: number) {
  let running = 0
  let arrivals = 0
  const queue: { priority: number; order: number; key?: string; start: () => void }[] = []

  const next = () => {
    while (running < slots && queue.length) {
      let best = 0
      for (let i = 1; i < queue.length; i++) {
        const a = queue[i]
        const b = queue[best]
        if (a.priority < b.priority || (a.priority === b.priority && a.order < b.order)) best = i
      }
      const [job] = queue.splice(best, 1)
      running++
      job.start()
    }
  }

  return {
    run<T>(job: () => Promise<T>, priority = 0, key?: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          priority,
          order: arrivals++,
          key,
          start: () => {
            let work: Promise<T>
            try {
              work = job()
            } catch (err) {
              work = Promise.reject(err)
            }
            void work.then(resolve, reject).finally(() => {
              running--
              next()
            })
          },
        })
        next()
      })
    },
    /** Moves a waiting job with this key up to `priority`, if that's sooner than it has. */
    raise(key: string, priority: number) {
      for (const q of queue) if (q.key === key && priority < q.priority) q.priority = priority
    },
    get running() {
      return running
    },
    get waiting() {
      return queue.length
    },
  }
}

export type Limiter = ReturnType<typeof limiter>
