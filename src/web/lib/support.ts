/** Names of required browser features that are missing; empty when the browser can run SyncRecord. */
export function supported(): string[] {
  const missing: string[] = [];
  if (typeof MediaRecorder === "undefined") missing.push("MediaRecorder");
  if (!navigator.mediaDevices?.getUserMedia) missing.push("getUserMedia");
  if (!navigator.storage?.getDirectory) missing.push("OPFS");
  if (!window.isSecureContext) missing.push("secure context (HTTPS)");
  return missing;
}
