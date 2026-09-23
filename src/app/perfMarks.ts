/** Per-launch startup timing, measured from navigation start, kept on this device only for diagnosing slow launches. */
export type LaunchMark = 'runtime-ready' | 'principal-ready' | 'session-ready' | 'app-mounted' | 'home-cached' | 'home-content' | 'group-cached' | 'group-header' | 'group-content'

export interface LaunchRecord {
  readonly startedAt: string
  readonly path: string
  readonly standalone: boolean
  readonly marks: Partial<Record<LaunchMark, number>>
}

const HISTORY_KEY = 'split-unwise:launch-timing:v1'
const HISTORY_LIMIT = 10
const CONTENT_MARKS: readonly LaunchMark[] = ['home-content', 'group-content']

let current: { startedAt: string; path: string; standalone: boolean; marks: Partial<Record<LaunchMark, number>> } | undefined
let reported = false
const markListeners = new Set<(mark: LaunchMark) => void>()

/** Records the first time this launch reaches a milestone; later calls for the same mark are ignored. */
export function markLaunch(mark: LaunchMark): void {
  if (typeof performance === 'undefined') return
  const record = currentLaunch()
  if (record.marks[mark] !== undefined) return
  record.marks[mark] = Math.round(performance.now())
  try { performance.mark(`split-unwise:${mark}`) } catch { /* marks are optional */ }
  for (const listener of [...markListeners]) listener(mark)
  if (!reported && CONTENT_MARKS.includes(mark)) {
    reported = true
    persist(record)
    console.info('[Split Unwise perf]', describeLaunch(record))
  } else if (reported) {
    persist(record)
  }
}

/** Resolves true once this launch reaches any of `marks` (immediately if it already has), or false after `timeoutMs`. */
export function waitForLaunchMark(marks: readonly LaunchMark[], timeoutMs: number): Promise<boolean> {
  if (current && marks.some((mark) => current!.marks[mark] !== undefined)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const listener = (mark: LaunchMark) => {
      if (!marks.includes(mark)) return
      finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    function finish(reached: boolean): void {
      clearTimeout(timer)
      markListeners.delete(listener)
      resolve(reached)
    }
    markListeners.add(listener)
  })
}

export function readLaunchHistory(): readonly LaunchRecord[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HISTORY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isLaunchRecord) : []
  } catch { return [] }
}

export function describeLaunch(record: LaunchRecord): string {
  const order: readonly LaunchMark[] = ['runtime-ready', 'principal-ready', 'session-ready', 'app-mounted', 'home-cached', 'home-content', 'group-cached', 'group-header', 'group-content']
  return order.filter((mark) => record.marks[mark] !== undefined).map((mark) => `${mark} ${record.marks[mark]}ms`).join(' · ')
}

function currentLaunch(): NonNullable<typeof current> {
  if (!current) {
    current = {
      startedAt: new Date(Date.now() - Math.round(performance.now())).toISOString(),
      path: typeof location === 'undefined' ? '' : location.pathname.replace(/\/grp-[^/]+/, '/:group'),
      standalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
      marks: {},
    }
    if (typeof window !== 'undefined') (window as typeof window & { __splitUnwisePerf?: unknown }).__splitUnwisePerf = { current, history: readLaunchHistory }
  }
  return current
}

function persist(record: LaunchRecord): void {
  try {
    if (typeof localStorage === 'undefined') return
    const history = readLaunchHistory().filter((entry) => entry.startedAt !== record.startedAt)
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{ ...record, marks: { ...record.marks } }, ...history].slice(0, HISTORY_LIMIT)))
  } catch { /* timing history is a convenience */ }
}

function isLaunchRecord(value: unknown): value is LaunchRecord {
  return value !== null && typeof value === 'object' && typeof (value as LaunchRecord).startedAt === 'string' && typeof (value as LaunchRecord).marks === 'object'
}
