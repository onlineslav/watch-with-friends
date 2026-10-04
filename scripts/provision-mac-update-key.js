// One-time maintainer setup. Private material goes only to a DPAPI-protected
// backup outside the repo and a GitHub Actions secret; stdout contains no keys.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {generateKeyPairSync} = require('node:crypto')
const {execFileSync} = require('node:child_process')
const config = path.resolve(__dirname, '../config/update-key.json')
if (process.platform !== 'win32') throw new Error('This provisioning script uses Windows DPAPI')
if (fs.existsSync(config)) throw new Error('An update key already exists. Do not rotate it without a migration.')
const {privateKey, publicKey} = generateKeyPairSync('ed25519')
const seed = privateKey.export({type: 'pkcs8', format: 'der'}).subarray(-32)
const pub = publicKey.export({type: 'spki', format: 'der'}).subarray(-32)
const secret = seed.toString('base64') // Sparkle's current key format is the raw 32-byte seed
const backup = path.join(os.homedir(), '.codex', 'secrets', 'watch-with-friends-mac-update-key.dpapi')
fs.mkdirSync(path.dirname(backup), {recursive: true})
if (fs.existsSync(backup)) throw new Error('Signing-key backup already exists')
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$keyText = [Console]::In.ReadToEnd(); $encryptedKey = ConvertTo-SecureString -String $keyText -AsPlainText -Force | ConvertFrom-SecureString; Set-Content -LiteralPath $env:WWF_KEY_BACKUP -Value $encryptedKey -NoNewline'],
{input: secret, env: {...process.env, WWF_KEY_BACKUP: backup}, stdio: ['pipe', 'pipe', 'pipe']})
execFileSync('gh', ['secret', 'set', 'MAC_UPDATE_PRIVATE_KEY', '--repo', 'onlineslav/watch-with-friends'], {input: secret, stdio: ['pipe', 'pipe', 'pipe']})
fs.writeFileSync(config, `${JSON.stringify({publicKey: pub.toString('base64')}, null, 2)}\n`)
console.log('Mac update signing configured; encrypted backup saved outside the repository.')
