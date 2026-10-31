// Compiles native/win-app-audio/main.cpp into a standalone per-app audio capture helper (WASAPI
// process loopback). Built from source like mac-app-audio, with the Visual C++ build tools that
// vswhere finds (any Visual Studio 2017+ or Build Tools install with the C++ workload, which the
// GitHub Windows runners have). The C runtime is linked statically, so the helper runs on
// machines without the Visual C++ redistributable.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')

const root = path.resolve(__dirname, '..')
const source = path.join(root, 'native/win-app-audio/main.cpp')
const defaultTarget = path.join(root, 'native/win-app-audio/win-app-audio.exe')

function vcvars() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!fs.existsSync(vswhere)) throw new Error('Building win-app-audio needs the Visual Studio C++ build tools (vswhere.exe not found)')
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {encoding: 'utf8'}).trim()
  const script = install && path.join(install, 'VC/Auxiliary/Build/vcvarsall.bat')
  if (!script || !fs.existsSync(script)) throw new Error('Building win-app-audio needs the Visual Studio C++ build tools (no install with the C++ workload found)')
  return script
}

function build(arch = process.arch, target = defaultTarget) {
  if (process.platform !== 'win32') throw new Error('Build win-app-audio on Windows')
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows architecture')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  const objects = fs.mkdtempSync(path.join(os.tmpdir(), 'win-app-audio-'))
  // vcvarsall only sets up the compiler's environment for the cmd.exe it runs in, so the
  // compile has to run in that same shell.
  const vcArch = arch === 'arm64' ? 'x64_arm64' : 'x64'
  const command = [
    `"${vcvars()}" ${vcArch} >nul 2>&1`,
    `cl /nologo /O2 /MT /EHsc /std:c++17 /W4 /WX /DUNICODE /D_UNICODE "${source}" /Fo"${objects}\\\\" /Fe"${target}" /link ole32.lib user32.lib mmdevapi.lib`,
  ].join(' && ')
  try {
    execFileSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {stdio: 'inherit', windowsVerbatimArguments: true})
  } finally {
    fs.rmSync(objects, {recursive: true, force: true})
  }
  console.log(`Built win-app-audio for ${arch}`)
  return {target}
}

// For dev (npm start): build once, and skip silently off Windows or once it's up to date. A
// machine without the C++ tools still starts; only the "shared window's audio" option fails,
// with a message saying the helper is missing.
function buildIfNeeded() {
  if (process.platform !== 'win32') return
  if (fs.existsSync(defaultTarget) && fs.statSync(defaultTarget).mtimeMs > fs.statSync(source).mtimeMs) return
  try {
    build()
  } catch (error) {
    console.warn(`Skipping win-app-audio: ${error.message}`)
  }
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--if-needed') buildIfNeeded()
    else build(process.argv[2])
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = {build, buildIfNeeded}
