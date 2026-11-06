/// <reference types="vite/client" />

// Injected by the Medusa admin build into plugin code. Both are read when the
// SDK is built, because a hard-coded session auth breaks JWT-configured hosts.
declare const __BACKEND_URL__: string | undefined
declare const __AUTH_TYPE__: "session" | "jwt" | undefined
