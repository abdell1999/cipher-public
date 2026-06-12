import type { WorkerMessage, WorkerResponse } from '../composables/useWorker'

const MAGIC_BYTES = new Uint8Array([0x41, 0x42, 0x52, 0x53, 0x54, 0x45, 0x47, 0x4f])

export interface StegoEncodePayload {
  op: 'encode'
  carrierBytes: ArrayBuffer
  payloadBytes: ArrayBuffer
  payloadName: string
}

export interface StegoDecodePayload {
  op: 'decode'
  imageBytes: ArrayBuffer
}

export type StegoPayload = StegoEncodePayload | StegoDecodePayload

export interface StegoEncodeResult { bytes: ArrayBuffer }
export interface StegoDecodeResult { bytes: ArrayBuffer; filename: string }
export type StegoResult = StegoEncodeResult | StegoDecodeResult

export async function encodePayload(
  carrierBytes: ArrayBuffer,
  payloadBytes: ArrayBuffer,
  payloadName: string,
): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([carrierBytes]))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D context not available')
  ctx.drawImage(bitmap as unknown as ImageBitmap, 0, 0)

  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  const pixels = imageData.data

  const payload = new Uint8Array(payloadBytes)
  const filenameBytes = new TextEncoder().encode(payloadName)
  const requiredBytes = MAGIC_BYTES.length + 4 + filenameBytes.length + 4 + payload.length
  const requiredBits = requiredBytes * 8
  const availableBits = Math.floor((pixels.length / 4) * 3)

  if (requiredBits > availableBits) {
    throw new Error(
      `Payload too large. Required: ${requiredBytes} bytes, Available: ${Math.floor(availableBits / 8)} bytes.`,
    )
  }

  const dataToEmbed = new Uint8Array(requiredBytes)
  let offset = 0
  dataToEmbed.set(MAGIC_BYTES, offset); offset += MAGIC_BYTES.length

  const filenameLenView = new DataView(new ArrayBuffer(4))
  filenameLenView.setUint32(0, filenameBytes.length, false)
  dataToEmbed.set(new Uint8Array(filenameLenView.buffer), offset); offset += 4
  dataToEmbed.set(filenameBytes, offset); offset += filenameBytes.length

  const payloadLenView = new DataView(new ArrayBuffer(4))
  payloadLenView.setUint32(0, payload.length, false)
  dataToEmbed.set(new Uint8Array(payloadLenView.buffer), offset); offset += 4
  dataToEmbed.set(payload, offset)

  const numPixels = pixels.length / 4
  let bitIndex = 0
  for (let p = 0; p < numPixels && bitIndex < requiredBits; p++) {
    for (let c = 0; c < 3 && bitIndex < requiredBits; c++) {
      const i = p * 4 + c
      const byteIndex = Math.floor(bitIndex / 8)
      const bitInByte = 7 - (bitIndex % 8)
      const bitValue = (dataToEmbed[byteIndex] >> bitInByte) & 1
      pixels[i] = (pixels[i] & ~1) | bitValue
      bitIndex++
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}

export async function decodePayload(
  imageBytes: ArrayBuffer,
): Promise<{ bytes: ArrayBuffer; filename: string }> {
  const bitmap = await createImageBitmap(new Blob([imageBytes]))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D context not available')
  ctx.drawImage(bitmap as unknown as ImageBitmap, 0, 0)

  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  const pixels = imageData.data

  let currentBitIndex = 0

  function readBytes(numBytes: number): Uint8Array {
    const result = new Uint8Array(numBytes)
    const numPixels = pixels.length / 4
    const totalBitsNeeded = numBytes * 8
    let bitsRead = 0
    const startPixel = Math.floor(currentBitIndex / 3)
    const startChannel = currentBitIndex % 3

    for (let p = startPixel; p < numPixels && bitsRead < totalBitsNeeded; p++) {
      const cStart = p === startPixel ? startChannel : 0
      for (let c = cStart; c < 3 && bitsRead < totalBitsNeeded; c++) {
        const i = p * 4 + c
        const bitValue = pixels[i] & 1
        const byteIdx = Math.floor(bitsRead / 8)
        const bitInByte = 7 - (bitsRead % 8)
        result[byteIdx] |= bitValue << bitInByte
        bitsRead++
        currentBitIndex++
      }
    }
    return result
  }

  const readMagic = readBytes(MAGIC_BYTES.length)
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (readMagic[i] !== MAGIC_BYTES[i]) {
      throw new Error('No hidden data found or format unsupported (magic bytes mismatch).')
    }
  }

  const filenameLenBytes = readBytes(4)
  const filenameLen = new DataView(
    filenameLenBytes.buffer,
    filenameLenBytes.byteOffset,
    4,
  ).getUint32(0, false)
  if (filenameLen > 1024) throw new Error('Corrupted hidden data (invalid filename length).')

  const filenameRaw = readBytes(filenameLen)
  const filename = new TextDecoder().decode(filenameRaw)

  const payloadLenBytes = readBytes(4)
  const payloadLen = new DataView(
    payloadLenBytes.buffer,
    payloadLenBytes.byteOffset,
    4,
  ).getUint32(0, false)

  const availableBits = Math.floor((pixels.length / 4) * 3)
  if (currentBitIndex + payloadLen * 8 > availableBits) {
    throw new Error('Corrupted hidden data (payload length exceeds image capacity).')
  }

  const payloadData = readBytes(payloadLen)
  return { bytes: payloadData.buffer as ArrayBuffer, filename }
}

self.onmessage = async (e: MessageEvent<WorkerMessage<StegoPayload>>) => {
  if (e.data.type === 'cancel') return
  const w = self as unknown as Worker
  try {
    const payload = e.data.payload
    if (payload.op === 'encode') {
      const bytes = await encodePayload(payload.carrierBytes, payload.payloadBytes, payload.payloadName)
      w.postMessage(
        { type: 'done', result: { bytes } } satisfies WorkerResponse<StegoResult>,
        [bytes],
      )
    } else {
      const { bytes, filename } = await decodePayload(payload.imageBytes)
      w.postMessage(
        { type: 'done', result: { bytes, filename } } satisfies WorkerResponse<StegoResult>,
        [bytes],
      )
    }
  } catch (err) {
    w.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    } satisfies WorkerResponse)
  }
}
