// Compiles the Windows native helpers: native/win-app-audio/main.cpp, the per-app audio capture
// helper (WASAPI process loopback), and native/win-app-windows/main.cpp, which reports where one
// app's windows are for a whole-app share. Built from source like mac-app-audio, with the Visual
// C++ build tools that vswhere finds (any Visual Studio 2017+ or Build Tools install with the C++
// workload, which the GitHub Windows runners have). The C runtime is linked statically, so the
// helpers run on machines without the Visual C++ redistributable.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')

const root = path.resolve(__dirname, '..')
const HELPERS = {
  'win-app-audio': ['ole32.lib', 'user32.lib', 'mmdevapi.lib'],
  'win-app-windows': ['user32.lib', 'dwmapi.lib'],
}
const sourceOf = (name) => path.join(root, `native/${name}/main.cpp`)
const targetOf = (name) => path.join(root, `native/${name}/${name}.exe`)

function vcvars() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!fs.existsSync(vswhere)) throw new Error('Building the Windows helpers needs the Visual Studio C++ build tools (vswhere.exe not found)')
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {encoding: 'utf8'}).trim()
  const script = install && path.join(install, 'VC/Auxiliary/Build/vcvarsall.bat')
  if (!script || !fs.existsSync(script)) throw new Error('Building the Windows helpers needs the Visual Studio C++ build tools (no install with the C++ workload found)')
  return script
}

function buildOne(name, arch) {
  const source = sourceOf(name)
  const target = targetOf(name)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  const objects = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  // vcvarsall only sets up the compiler's environment for the cmd.exe it runs in, so the
  // compile has to run in that same shell.
  const vcArch = arch === 'arm64' ? 'x64_arm64' : 'x64'
  const command = [
    `"${vcvars()}" ${vcArch} >nul 2>&1`,
    `cl /nologo /O2 /MT /EHsc /std:c++17 /W4 /WX /DUNICODE /D_UNICODE "${source}" /Fo"${objects}\\\\" /Fe"${target}" /link ${HELPERS[name].join(' ')}`,
  ].join(' && ')
  try {
    execFileSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {stdio: 'inherit', windowsVerbatimArguments: true})
  } finally {
    fs.rmSync(objects, {recursive: true, force: true})
  }
  console.log(`Built ${name} for ${arch}`)
  return target
}

function build(arch = process.arch) {
  if (process.platform !== 'win32') throw new Error('Build the Windows helpers on Windows')
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows architecture')
  return {targets: Object.keys(HELPERS).map((name) => buildOne(name, arch))}
}

// For dev (npm start): build each once, and skip silently off Windows or once it's up to date. A
// machine without the C++ tools still starts; only the options needing a helper fail, with a
// message saying the helper is missing.
function buildIfNeeded() {
  if (process.platform !== 'win32') return
  for (const name of Object.keys(HELPERS)) {
    const target = targetOf(name)
    if (fs.existsSync(target) && fs.statSync(target).mtimeMs > fs.statSync(sourceOf(name)).mtimeMs) continue
    try {
      buildOne(name, process.arch)
    } catch (error) {
      console.warn(`Skipping ${name}: ${error.message}`)
    }
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
