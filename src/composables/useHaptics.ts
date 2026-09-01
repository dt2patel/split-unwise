import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

export interface HapticCapabilities {
  readonly vibrate?: (pattern: number | number[]) => boolean
}

/** Uses the available browser haptic capability without making it a requirement. */
export function useHaptics(capabilities?: HapticCapabilities) {
  const triggerWeb = async (pattern: number | number[]): Promise<boolean> => {
    const vibrate = capabilities ? capabilities.vibrate : browserVibrate()
    try { return vibrate?.(pattern) ?? false } catch { return false }
  }

  return {
    async light() {
      if (!capabilities && Capacitor.isNativePlatform()) { try { await Haptics.impact({ style: ImpactStyle.Light }); return true } catch { return false } }
      return triggerWeb(10)
    },
    async warning() {
      if (!capabilities && Capacitor.isNativePlatform()) { try { await Haptics.notification({ type: NotificationType.Warning }); return true } catch { return false } }
      return triggerWeb([18, 40, 18])
    },
  }
}

function browserVibrate(): HapticCapabilities['vibrate'] | undefined {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
    ? navigator.vibrate.bind(navigator)
    : undefined
}
