// User-facing copy uses the existing Home card; native details stay in diagnostics.
export function describeUpdate(status) {
  const version = typeof status?.version === 'string' && /^\d+\.\d+\.\d+$/.test(status.version) ? `Version ${status.version}` : 'Update'
  switch (status?.phase) {
    case 'downloading': {
      const progress = Number.isFinite(status.progress) ? ` (${Math.max(0, Math.min(100, Math.floor(status.progress)))}%)` : ''
      return {text: `${version} is downloading${progress}. You can keep watching.`}
    }
    case 'extracting': return {text: `${version} is being prepared. You can keep watching.`}
    case 'ready': return {text: status.inRoom ? `${version} is ready. It will install after you leave the room.` : `${version} is ready. The app will restart shortly.`}
    case 'installing': return {text: `${version} is installing. The app will reopen automatically.`}
    case 'error': return {text: 'The update could not finish. Your current app still works. We will retry automatically.', retry: true}
    case 'blocked': return {text: 'Move the app to a writable Applications folder to enable automatic updates.', retry: true}
    default: return null
  }
}
