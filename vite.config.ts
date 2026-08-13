import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [tailwindcss(), reactRouter()],
    server: {
      proxy: {
        "/api": {
          target: env.VITE_ENGINE_URL || env.VITE_API_URL || "http://127.0.0.1:8787",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    resolve: {
      tsconfigPaths: true,
    },
  };
});
