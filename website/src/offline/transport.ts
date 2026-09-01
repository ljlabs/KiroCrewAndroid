type NativeFetch = typeof window.fetch

let nativeFetch: NativeFetch | null = null

/** Capture the browser transport before the global interceptor replaces it. */
export function captureNativeFetch(): NativeFetch {
  if (!nativeFetch) nativeFetch = window.fetch.bind(window)
  return nativeFetch
}

/** Send a request without passing through the offline interceptor. */
export function fetchDirect(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return captureNativeFetch()(input, init)
}
