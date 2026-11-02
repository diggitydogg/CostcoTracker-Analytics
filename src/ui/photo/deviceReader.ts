import { readOnDevice, releaseOnDeviceReader, type OnDeviceRead } from './onDevice'
import { prepareImage } from './prepareImage'

/** The on-device steps of photo matching, injectable for tests (jsdom has no canvas decoding or WebAssembly OCR). */
export type DeviceReader = {
  prepare: (file: File) => Promise<{ dataUrl: string; canvas?: HTMLCanvasElement }>
  read: (image: { dataUrl: string; canvas?: HTMLCanvasElement }, onProgress: (f: number) => void) => Promise<OnDeviceRead>
  release: () => void
}

export const browserDeviceReader: DeviceReader = {
  prepare: prepareImage,
  read: (image, onProgress) => readOnDevice(image.canvas!, onProgress),
  release: releaseOnDeviceReader,
}
