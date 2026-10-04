const fs = require('node:fs')
const path = require('node:path')
const {sign, createPrivateKey, createPublicKey} = require('node:crypto')
const {execFileSync} = require('node:child_process')
const PUBLIC_KEY = require('../config/update-key.json').publicKey

const xml = (text) => String(text).replace(/[<>&"']/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]))
function privateKey(secret, expectedPublicKey = PUBLIC_KEY) {
  const bytes = Buffer.from(secret || '', 'base64')
  if (bytes.length !== 32) throw new Error('Mac update signing key is missing or invalid')
  const key = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]), type: 'pkcs8', format: 'der'})
  const publicKey = createPublicKey(key).export({type: 'spki', format: 'der'}).subarray(-32)
  if (publicKey.toString('base64') !== expectedPublicKey) throw new Error('Mac update signing key does not match the app')
  return key
}
function appcast({version, arch, name, length, signature, base = 'https://github.com/onlineslav/watch-with-friends/releases/download'}) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['arm64', 'x64'].includes(arch)) throw new Error('Invalid update version or architecture')
  if (!Number.isSafeInteger(length) || length <= 0 || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid update signature or length')
  const download = `${base}/v${version}/${encodeURIComponent(name)}`
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>Watch With Friends — ${arch}</title><item><title>Version ${version}</title>
<sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>
<enclosure url="${xml(download)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${signature}"/>
</item></channel></rss>\n`
}
function writeFeed({archive, version, arch, secret, out, vendor}) {
  const key = privateKey(secret)
  const data = fs.readFileSync(archive)
  const signature = sign(null, data, key).toString('base64')
  const feed = appcast({version, arch, name: path.basename(archive), length: data.length, signature})
  fs.writeFileSync(out, feed)
  // Sparkle itself signs the feed, so feed metadata is authenticated too.
  execFileSync(path.join(vendor, 'bin', 'sign_update'), ['--ed-key-file', '-', out], {input: `${secret}\n`, stdio: ['pipe', 'pipe', 'pipe']})
}
if (require.main === module) {
  const arch = process.argv[2]
  const {version, name} = require('../package.json')
  const archive = path.resolve('dist', `${name}-${version}-mac-${arch}.zip`)
  try {
    writeFeed({archive, version, arch, secret: process.env.MAC_UPDATE_PRIVATE_KEY, out: path.resolve('dist', `appcast-${arch}.xml`), vendor: path.resolve('.cache/sparkle', require('./build-mac-updater').VERSION)})
    console.log(`Signed Mac ${arch} update and feed for ${version}`)
  } catch (error) { console.error('Mac update signing failed. Check the signing key and archive.'); process.exitCode = 1 }
}
module.exports = {xml, privateKey, appcast, writeFeed}
