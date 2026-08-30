import { describe, expect, it } from 'vitest'
import { CommandConflictError, CommandQueue } from '../commandQueue'

describe('CommandQueue', () => {
  it('uses an operation ID once while exposing pending and fresh states', async () => {
    const queue = new CommandQueue()
    let calls = 0
    let release: (value: string) => void = () => undefined
    const completion = new Promise<string>((resolve) => { release = resolve })

    const first = queue.submit({
      id: 'write-firewood',
      execute: async () => {
        calls += 1
        return completion
      },
    })

    expect(queue.get('write-firewood')).toMatchObject({ status: 'pending' })
    release('saved')
    await expect(first).resolves.toBe('saved')
    await expect(queue.submit({ id: 'write-firewood', execute: async () => 'duplicate' })).resolves.toBe('saved')
    expect(calls).toBe(1)
    expect(queue.get('write-firewood')).toMatchObject({ status: 'fresh', result: 'saved' })
    expect(queue.markStale('write-firewood')).toMatchObject({ status: 'stale', result: 'saved' })
    expect(queue.markFresh('write-firewood')).toMatchObject({ status: 'fresh', result: 'saved' })
  })

  it('retries only failed operations and publishes each retry transition', async () => {
    const queue = new CommandQueue()
    const states: string[] = []
    queue.subscribe((operation) => states.push(operation.status))
    let calls = 0

    await expect(queue.submit({
      id: 'retryable-write',
      execute: async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return 'saved after retry'
      },
    })).rejects.toThrow('offline')

    expect(queue.get('retryable-write')).toMatchObject({ status: 'failed' })
    await expect(queue.retry('retryable-write')).resolves.toBe('saved after retry')
    await expect(queue.retry('retryable-write')).rejects.toThrow('Only failed operations can be retried')
    expect(calls).toBe(2)
    expect(states).toEqual(['pending', 'failed', 'pending', 'fresh'])
  })

  it('retains a conflict without retrying its operation', async () => {
    const queue = new CommandQueue()
    let calls = 0

    await expect(queue.submit({
      id: 'conflicted-write',
      execute: async () => {
        calls += 1
        throw new CommandConflictError('remote revision changed', { revision: 'remote-2' })
      },
    })).rejects.toThrow('remote revision changed')

    expect(queue.get('conflicted-write')).toMatchObject({
      status: 'conflicted',
      conflict: { revision: 'remote-2' },
    })
    await expect(queue.retry('conflicted-write')).rejects.toThrow('Only failed operations can be retried')
    expect(calls).toBe(1)
  })
})
