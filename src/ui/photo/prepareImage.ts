import { PHOTO_LIMITS } from '../../analytics/products/photoMatch'

/**
 * Turns a camera or library photo into one bounded JPEG, entirely in the browser:
 * - decodes JPEG/PNG/WebP, and HEIC/HEIF where the browser can (Safari);
 * - applies the EXIF orientation (so text is upright for OCR);
 * - scales the longest side to PHOTO_LIMITS.maxDimension (packaging text stays legible);
 * - re-encodes as JPEG, which also DROPS ALL METADATA (EXIF location, device, time).
 * The original file is never uploaded or stored; the result lives in memory only.
 */
export type PreparedImage = { dataUrl: string; width: number; height: number; canvas: HTMLCanvasElement; bytes: number }

export class PhotoInputError extends Error {
  constructor(
    readonly code: 'unsupported' | 'too-large' | 'decode',
    message: string,
  ) {
    super(message)
  }
}

const MAX_FILE_BYTES = 40 * 1024 * 1024
const isImage = (f: File) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name)

async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Fall through to <img> (e.g. formats only the image element decodes).
    }
  }
  // A data: URL (allowed by the page's CSP), not a blob: URL.
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read'))
    r.readAsDataURL(file)
  })
  return await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight }))
    img.onerror = () => reject(new Error('decode'))
    img.src = url
  })
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isImage(file)) throw new PhotoInputError('unsupported', 'That file is not a photo. Choose a JPEG, PNG, WebP or HEIC image.')
  if (file.size > MAX_FILE_BYTES) throw new PhotoInputError('too-large', 'That photo is too large to process. Choose a smaller one.')
  let source: Awaited<ReturnType<typeof decode>>
  try {
    source = await decode(file)
  } catch {
    throw new PhotoInputError('decode', "This photo's format can't be read in this browser. Take the photo again, or choose a JPEG or PNG.")
  }
  const scale = Math.min(1, PHOTO_LIMITS.maxDimension / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PhotoInputError('decode', 'This browser cannot process photos here.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  if ('close' in source && typeof source.close === 'function') source.close()
  // Highest quality that fits the upload limit: degrade only as far as needed.
  let dataUrl = ''
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    dataUrl = canvas.toDataURL('image/jpeg', q)
    if ((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75 <= PHOTO_LIMITS.maxImageBytes) break
  }
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
  if (bytes > PHOTO_LIMITS.maxImageBytes) throw new PhotoInputError('too-large', 'That photo is too detailed to send. Try a closer, simpler shot.')
  return { dataUrl, width: canvas.width, height: canvas.height, canvas, bytes }
}
