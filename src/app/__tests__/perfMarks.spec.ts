import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

describe('launch timing marks', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('records each milestone once and saves the launch when content first appears', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const now = vi.spyOn(performance, 'now')
    const { markLaunch, readLaunchHistory } = await import('../perfMarks')

    now.mockReturnValue(120); markLaunch('runtime-ready')
    now.mockReturnValue(400); markLaunch('app-mounted')
    now.mockReturnValue(450); markLaunch('app-mounted')
    expect(readLaunchHistory()).toEqual([])

    now.mockReturnValue(900); markLaunch('group-content')
    const [launch] = readLaunchHistory()
    expect(launch?.marks).toEqual({ 'runtime-ready': 120, 'app-mounted': 400, 'group-content': 900 })
    expect(info).toHaveBeenCalledWith('[Split Unwise perf]', 'runtime-ready 120ms · app-mounted 400ms · group-content 900ms')
    info.mockRestore(); now.mockRestore()
  })

  it('keeps only the ten most recent launches', async () => {
    localStorage.setItem('split-unwise:launch-timing:v1', JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ startedAt: `2026-09-0${index}`, path: '/', standalone: false, marks: {} }))))
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { markLaunch, readLaunchHistory } = await import('../perfMarks')
    markLaunch('home-content')
    expect(readLaunchHistory()).toHaveLength(10)
    expect(readLaunchHistory()[0]?.marks['home-content']).toBeTypeOf('number')
  })
})
