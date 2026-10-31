const {Arch} = require('builder-util')
const checkTurn = require('./check-turn-config')
const {build} = require('./build-mac-updater')
const {build: buildAppAudio} = require('./build-mac-app-audio')
const {build: buildWinAppAudio} = require('./build-win-app-audio')
module.exports = async (context) => {
  checkTurn(context)
  if (context.electronPlatformName === 'win32') buildWinAppAudio(Arch[context.arch])
  if (context.electronPlatformName !== 'darwin') return
  const publicKey = require('../config/update-key.json').publicKey
  if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) throw new Error('Invalid Mac update public key')
  context.packager.config.mac.extendInfo.SUPublicEDKey = publicKey
  const arch = Arch[context.arch]
  context.packager.config.mac.extendInfo.SUFeedURL = `https://github.com/onlineslav/watch-with-friends/releases/latest/download/appcast-${arch}.xml`
  await build(arch)
  buildAppAudio(arch)
}
