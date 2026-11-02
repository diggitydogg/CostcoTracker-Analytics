/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Production-only Content Security Policy.
 *
 * The app only talks to its own same-origin API (`/api/*` on the owner's
 * deployment), so `connect-src 'self'` lets the browser refuse any attempt to
 * send data to any other host: no analytics, telemetry, fonts or CDNs. It is
 * only applied to the production build because the Vite dev server relies on
 * inline scripts and a websocket for hot reload.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function productionCsp(): Plugin {
  return {
    name: 'costcotracker-production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP },
          injectTo: 'head',
        },
      ]
    },
  }
}

/**
 * Self-hosted on-device OCR (tesseract.js) for photo matching: the worker,
 * the LSTM WebAssembly cores (the worker picks the one the browser supports)
 * and the English model are served from this origin under /ocr/, never from a
 * CDN, so `connect-src 'self'` and `script-src 'self'` keep holding. They are
 * only downloaded when someone uses photo matching, then cached by the browser.
 */
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`))
export const OCR_ASSETS: Record<string, string> = {
  'ocr/worker.min.js': join(pkgDir('tesseract.js'), 'dist/worker.min.js'),
  'ocr/core/tesseract-core-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js'),
  'ocr/core/tesseract-core-simd-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'),
  'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-relaxedsimd-lstm.wasm.js'),
  'ocr/lang/eng.traineddata.gz': join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int/eng.traineddata.gz'),
}

function ocrAssets(): Plugin {
  return {
    name: 'costcotracker-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]?.replace(/^\//, '') ?? ''
        const file = OCR_ASSETS[path]
        if (!file) return next()
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(OCR_ASSETS)) this.emitFile({ type: 'asset', fileName, source: readFileSync(file) })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), productionCsp(), ocrAssets()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
