import { spawnSync } from 'node:child_process'

const gatewayUrl = (process.env.KIROCREW_ANDROID_GATEWAY_URL || '').trim().replace(/\/$/, '')
if (!gatewayUrl || !/^https?:\/\//i.test(gatewayUrl)) {
  console.error(
    'KIROCREW_ANDROID_GATEWAY_URL must be set to the gateway origin used by the APK, for example https://crew.example.com',
  )
  process.exit(2)
}

if (gatewayUrl.startsWith('http://') && process.env.KIROCREW_ANDROID_ALLOW_CLEARTEXT !== '1') {
  console.error(
    'Refusing an HTTP Android gateway URL by default. Use HTTPS for a phone build, or set KIROCREW_ANDROID_ALLOW_CLEARTEXT=1 only for local testing.',
  )
  process.exit(2)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, KIROCREW_ANDROID_GATEWAY_URL: gatewayUrl },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npm', ['run', 'build'])
run('npx', ['cap', 'sync', 'android'])
