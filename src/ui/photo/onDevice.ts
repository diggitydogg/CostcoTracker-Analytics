import type { Barcode } from '../../analytics/products/photoMatch'

/**
 * Deterministic evidence read ON THE DEVICE (the photo never leaves it for
 * this): barcodes and text, like the iOS app's Apple Vision OCR/barcode step.
 * - Barcodes: the browser's BarcodeDetector where available, else ZXing (JS).
 * - Text: Tesseract (WebAssembly), self-hosted under /ocr/ and loaded only
 *   when photo matching is used; English LSTM model.
 * Neither calls any network service besides fetching its own files from this origin.
 */
export type OnDeviceRead = { lines: string[]; barcodes: Barcode[] }

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string; format: string }[]> }
type DetectorCtor = new (opts?: { formats?: string[] }) => Detector

async function readBarcodes(canvas: HTMLCanvasElement): Promise<Barcode[]> {
  const Native = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
  if (Native) {
    try {
      const found = await new Native().detect(canvas)
      return found.map((b) => ({ format: b.format, value: b.rawValue })).filter((b) => /^[0-9A-Za-z]{4,20}$/.test(b.value))
    } catch {
      // Fall back to ZXing below.
    }
  }
  try {
    const z = await import('@zxing/library')
    const hints = new Map<number, unknown>([
      [z.DecodeHintType.TRY_HARDER, true],
      [z.DecodeHintType.POSSIBLE_FORMATS, [z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8, z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E, z.BarcodeFormat.CODE_128, z.BarcodeFormat.CODE_39]],
    ])
    const reader = new z.MultiFormatReader()
    reader.setHints(hints)
    const bitmap = new z.BinaryBitmap(new z.HybridBinarizer(new z.HTMLCanvasElementLuminanceSource(canvas)))
    const r = reader.decode(bitmap)
    const value = r.getText()
    return /^[0-9A-Za-z]{4,20}$/.test(value) ? [{ format: z.BarcodeFormat[r.getBarcodeFormat()]!.toLowerCase(), value }] : []
  } catch {
    return [] // no barcode found (ZXing throws NotFoundException) or not decodable
  }
}

type OcrWorker = { recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> }
let worker: Promise<OcrWorker> | null = null
let progressListener: ((p: number) => void) | null = null

async function ocrWorker(): Promise<OcrWorker> {
  worker ??= import('tesseract.js').then(
    ({ createWorker }) =>
      createWorker('eng', 1 /* LSTM only */, {
        workerPath: '/ocr/worker.min.js',
        corePath: '/ocr/core',
        langPath: '/ocr/lang',
        workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') progressListener?.(m.progress)
        },
      }) as unknown as Promise<OcrWorker>,
  )
  try {
    return await worker
  } catch (error) {
    worker = null
    throw error
  }
}

/** Reads barcodes and text from the prepared photo, on the device. Throws only if on-device OCR cannot start. */
export async function readOnDevice(canvas: HTMLCanvasElement, onProgress?: (fraction: number) => void): Promise<OnDeviceRead> {
  const barcodes = await readBarcodes(canvas)
  progressListener = onProgress ?? null
  try {
    const w = await ocrWorker()
    const { data } = await w.recognize(canvas)
    const lines = data.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    return { lines, barcodes }
  } finally {
    progressListener = null
  }
}

/** Frees the OCR worker and its memory (called when the photo sheet closes). */
export function releaseOnDeviceReader(): void {
  const w = worker
  worker = null
  void w?.then((x) => x.terminate()).catch(() => {})
}
