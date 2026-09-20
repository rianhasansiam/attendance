/* Network-only: attendance, sessions and location evidence are never cached or queued. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
