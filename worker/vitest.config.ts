import { defineConfig } from "vitest/config";

// cloudflare:sockets only exists inside workerd; unit tests never open a socket.
export default defineConfig({
  resolve: { alias: { "cloudflare:sockets": new URL("./test/sockets-stub.ts", import.meta.url).pathname } },
});
