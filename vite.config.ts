import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PID Control Playground — line-follower simulator (portfolio demo)
export default defineConfig({
  server: { host: "::", port: 5182 },
  plugins: [react()],
});
