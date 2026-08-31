import { assessClientExport, type ClientExportAssessment } from '../../domain/exports'

export interface DownloadAnchor { href: string; download: string; click(): void; remove(): void }
export interface ClientDownloadEnvironment {
  readonly createObjectURL: (blob: Blob) => string
  readonly revokeObjectURL: (url: string) => void
  readonly createAnchor: () => DownloadAnchor
  readonly createBlob: (parts: BlobPart[], options: BlobPropertyBag) => Blob
}

export interface ClientDownloadManager {
  download(content: string, rowCount: number, fileName: string, mimeType: string): ClientExportAssessment
  dispose(): void
}

export function createClientDownloadManager(environment: ClientDownloadEnvironment = browserEnvironment()): ClientDownloadManager {
  const activeUrls = new Set<string>()
  return {
    download(content, rowCount, fileName, mimeType) {
      const assessment = assessClientExport(content, rowCount)
      if (assessment.status === 'server-required') return assessment
      if (!fileName.trim() || /[\\/\u0000-\u001f\u007f]/.test(fileName)) throw new Error('Download file name is invalid')
      const blob = environment.createBlob([content], { type: mimeType })
      const url = environment.createObjectURL(blob)
      activeUrls.add(url)
      const anchor = environment.createAnchor()
      try {
        anchor.href = url
        anchor.download = fileName
        anchor.click()
        return assessment
      } finally {
        anchor.remove()
        if (activeUrls.delete(url)) environment.revokeObjectURL(url)
      }
    },
    dispose() {
      for (const url of activeUrls) environment.revokeObjectURL(url)
      activeUrls.clear()
    },
  }
}

function browserEnvironment(): ClientDownloadEnvironment {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement('a'),
    createBlob: (parts, options) => new Blob(parts, options),
  }
}
