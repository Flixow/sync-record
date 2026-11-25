/** Names of required browser features that are missing; empty when the browser can run SyncRecord. */
export function supported(): string[] {
  const missing: string[] = [];
  if (typeof MediaRecorder === "undefined") missing.push("MediaRecorder");
  if (!navigator.mediaDevices?.getUserMedia) missing.push("getUserMedia");
  if (!navigator.storage?.getDirectory) missing.push("OPFS");
  if (!isChromium()) missing.push("Chromium-based browser");
  if (!window.isSecureContext) missing.push("secure context (HTTPS)");
  return missing;
}

/** Chrome, Edge, Brave, Opera and other Chromium builds; Firefox and Safari record in other formats. */
export function isChromium(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  if (brands) return brands.some((entry) => entry.brand === "Chromium");
  return /Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
}
