import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    port: 1421,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
