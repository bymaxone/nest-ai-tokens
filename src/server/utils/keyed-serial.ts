/**
 * @fileoverview Runs the work submitted under one key one piece at a time, in submission order.
 * Work under another key never waits. A piece waits for the settlement of the one before it,
 * whatever its outcome, and runs its own work: it inherits neither the previous value nor the
 * previous error. A key is held only while work under it is in flight. The state is per instance;
 * nothing is shared between instances or processes.
 * @layer server
 */

/** Serializes work per key. */
export class KeyedSerial {
  private readonly tails = new Map<string, Promise<void>>()

  /** The number of keys with work in flight. */
  get size(): number {
    return this.tails.size
  }

  /**
   * Run `work` after the work already submitted under `key` has settled.
   *
   * @param key What the work is serialized on.
   * @param work The work to run.
   * @returns What `work` returns, or rejects with.
   */
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    // `await` settles a native promise without looking up its `then`, so a `Promise` that an agent wrapped after load is not reached.
    const prior = this.tails.get(key)
    const turn = (async (): Promise<T> => {
      await prior
      return await work()
    })()
    const tail = (async (): Promise<void> => {
      try {
        await turn
      } catch {
        // the next piece waits for the settlement of this one, whatever its outcome
      }
    })()
    this.tails.set(key, tail)
    try {
      return await turn
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
