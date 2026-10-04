// Each request carries one bounded chunk, independent of the original file's size.
const DOWNLOAD_CHUNK_BYTES = 256 * 1024
const MAX_DOWNLOADS = 3
const validFileSize = (size) => Number.isSafeInteger(size) && size >= 0
const downloadName = (name) => {
  let base = String(name || '').split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = `_${base}`
  if (base.length > 200) {
    const dot = base.lastIndexOf('.')
    const extension = dot > 0 && base.length - dot <= 20 ? base.slice(dot) : ''
    base = base.slice(0, 200 - extension.length).replace(/[. ]+$/, '') + extension
  }
  return base.replace(/[. ]+$/, '') || 'download'
}
module.exports = {DOWNLOAD_CHUNK_BYTES, MAX_DOWNLOADS, validFileSize, downloadName}
