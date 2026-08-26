/**
 * Shrink photos before POST /api/chat/media so Cloudflare's ~100s
 * origin window (HTTP 524) is less likely on phone-camera originals.
 */

export const COMPRESS_SKIP_BYTES = 400 * 1024
export const COMPRESS_MAX_EDGE = 1920
export const COMPRESS_QUALITY = 0.82

export function shouldCompressImage(file: File): boolean {
  if (file.size <= COMPRESS_SKIP_BYTES) return false
  if (!file.type.startsWith('image/')) return false
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return false
  return true
}

export async function compressImageForUpload(file: File): Promise<File> {
  if (!shouldCompressImage(file)) return file
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return file
  }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((next) => resolve(next), 'image/jpeg', COMPRESS_QUALITY)
    })
    if (!blob || blob.size === 0 || blob.size >= file.size) return file
    const name = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  }
}
