const test = require('node:test')
const assert = require('node:assert/strict')
const {generateKeyPairSync, sign, verify} = require('node:crypto')
const {privateKey, appcast, xml} = require('../scripts/mac-update-feed')
function pair() {
  const {privateKey: key, publicKey} = generateKeyPairSync('ed25519')
  return {key, publicKey, publicBase64: publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64'), secret: key.export({format: 'der', type: 'pkcs8'}).subarray(-32).toString('base64')}
}
test('raw Sparkle Ed25519 seeds produce signatures accepted by the matching public key', () => {
  const keys = pair()
  const key = privateKey(keys.secret, keys.publicBase64)
  const archive = Buffer.from('update archive')
  const signature = sign(null, archive, key)
  assert.ok(verify(null, archive, keys.publicKey, signature))
  assert.equal(verify(null, Buffer.from('tampered'), keys.publicKey, signature), false)
  assert.equal(verify(null, archive, pair().publicKey, signature), false)
})
test('missing, malformed, expanded or mismatched signing keys fail closed', () => {
  const keys = pair()
  for (const key of ['', 'bad', Buffer.alloc(64).toString('base64'), pair().secret]) assert.throws(() => privateKey(key, keys.publicBase64))
})
test('feeds are separate by architecture and point to an immutable tagged archive', () => {
  const signature = Buffer.alloc(64).toString('base64')
  for (const arch of ['arm64', 'x64']) {
    const feed = appcast({version: '1.2.3', arch, name: `watch-with-friends-1.2.3-mac-${arch}.zip`, length: 100, signature})
    assert.match(feed, new RegExp(`/v1.2.3/watch-with-friends-1.2.3-mac-${arch}\\.zip`))
    assert.ok(feed.includes(`sparkle:edSignature="${signature}"`))
    assert.ok(feed.includes('<sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>'))
  }
})
test('release metadata rejects prereleases/invalid architecture/length/signatures and escapes XML', () => {
  const args = {version: '1.2.3', arch: 'arm64', name: 'app.zip', length: 123, signature: Buffer.alloc(64).toString('base64')}
  for (const change of [{version: '1.2.3-beta'}, {arch: 'universal'}, {length: -1}, {length: Infinity}, {signature: '<tag>'}]) assert.throws(() => appcast({...args, ...change}))
  assert.equal(xml('<>&"\''), '&lt;&gt;&amp;&quot;&apos;')
})
