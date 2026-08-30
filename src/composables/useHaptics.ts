export interface HapticCapabilities {
  readonly vibrate?: (pattern: number | number[]) => boolean
}

/** Uses the available browser haptic capability without making it a requirement. */
export function useHaptics(capabilities?: HapticCapabilities) {
  const vibrate = capabilities ? capabilities.vibrate : browserVibrate()
  const trigger = async (pattern: number | number[]): Promise<boolean> => {
    try { return vibrate?.(pattern) ?? false } catch { return false }
  }

  return {
    light: () => trigger(10),
    warning: () => trigger([18, 40, 18]),
  }
}

function browserVibrate(): HapticCapabilities['vibrate'] | undefined {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
    ? navigator.vibrate.bind(navigator)
    : undefined
}
