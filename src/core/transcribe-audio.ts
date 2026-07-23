/**
 * Shared audio prep for STT providers that want 16 kHz mono PCM WAV.
 */

import { spawn } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { TranscribeError, type TranscribeProvider } from './transcribe-types.js'

/**
 * Convert any ffmpeg-readable file to 16 kHz mono PCM WAV.
 * Already-WAV inputs are copied through (no re-encode) so unit tests and
 * hosts without ffmpeg can still exercise cloud STT HTTP paths.
 */
export async function convertToWav(
  inputPath: string,
  outputPath: string,
  provider: TranscribeProvider = 'whispercpp',
): Promise<void> {
  if (inputPath.toLowerCase().endsWith('.wav')) {
    if (inputPath !== outputPath) await copyFile(inputPath, outputPath)
    return
  }

  const args = [
    '-y', '-loglevel', 'error',
    '-i', inputPath,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    outputPath,
  ]
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr: Buffer[] = []
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      settle(() => reject(new TranscribeError('ffmpeg conversion timeout (30s)', provider)))
    }, 30 * 1000)
    child.stderr.on('data', (b: Buffer) => stderr.push(b))
    child.on('error', (e) => {
      clearTimeout(timer)
      settle(() => reject(new TranscribeError(`ffmpeg spawn failed: ${e.message}`, provider)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        settle(() => resolve())
        return
      }
      const errText = Buffer.concat(stderr).toString().slice(0, 400)
      settle(() => reject(new TranscribeError(`ffmpeg exit ${code}: ${errText}`, provider)))
    })
  })
}
