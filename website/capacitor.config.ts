import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android packaging deliberately reuses the website build instead of creating
 * a second mobile UI. Set KIROCREW_ANDROID_GATEWAY_URL to the HTTPS origin of
 * the gateway when building the APK; Capacitor then loads the same authenticated
 * dashboard origin, preserving relative API, cookie, WebSocket, and service
 * worker behavior. Without it, the normal local dist bundle is used for web
 * development and browser preview.
 */
const gatewayUrl = process.env.KIROCREW_ANDROID_GATEWAY_URL?.trim().replace(/\/$/, '')

const config: CapacitorConfig = {
  appId: 'dev.kiro.crew',
  appName: 'Kiro Crew',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: gatewayUrl
    ? {
        url: gatewayUrl,
        cleartext: gatewayUrl.startsWith('http://'),
      }
    : undefined,
  android: {
    backgroundColor: '#0b0d12',
  },
}

export default config
