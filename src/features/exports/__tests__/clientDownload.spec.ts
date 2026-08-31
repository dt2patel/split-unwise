import { describe, expect, it, vi } from 'vitest'
import { createClientDownloadManager } from '../clientDownload'

describe('bounded client download lifecycle', () => {
  it('checks limits before Blob creation and revokes the URL after a successful click', () => {
    const createObjectURL = vi.fn(() => 'blob:export')
    const revokeObjectURL = vi.fn()
    const click = vi.fn()
    const manager = createClientDownloadManager({ createObjectURL, revokeObjectURL, createAnchor: () => ({ href: '', download: '', click, remove: vi.fn() }), createBlob: (parts, options) => new Blob(parts, options) })

    expect(manager.download('hello', 1, 'report.csv', 'text/csv;charset=utf-8')).toMatchObject({ status: 'ready', rowCount: 1 })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export')

    expect(manager.download('x', 5_001, 'too-large.csv', 'text/csv')).toMatchObject({ status: 'server-required', reason: 'row-limit' })
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('revokes active URLs when creation fails or the owner is disposed', () => {
    const revokeObjectURL = vi.fn()
    const manager = createClientDownloadManager({ createObjectURL: () => 'blob:failure', revokeObjectURL, createAnchor: () => ({ href: '', download: '', click: () => { throw new Error('cancelled') }, remove: vi.fn() }), createBlob: (parts, options) => new Blob(parts, options) })
    expect(() => manager.download('hello', 1, 'report.csv', 'text/csv')).toThrow('cancelled')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failure')
    manager.dispose()
  })
})
