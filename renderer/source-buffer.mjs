// A SourceBuffer refuses timestampOffset, appendBuffer and remove while `updating` is true ("Failed to set
// 'timestampOffset' on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation").
// player.mjs used to wait for ONE 'updateend' after starting a remove, but abort() (called just before, to reset the
// parser) queues an 'updateend' of its own when it cuts a running append or remove short; that earlier event
// satisfied the wait while the remove was still running, and the seek's timestampOffset then threw (M1.7, seen as an
// intermittent test:network player error at "playlist progress"). Wait for the flag, not for an event.
export async function whenIdle(buffer) {
  while (buffer.updating) await new Promise((resolve) => buffer.addEventListener('updateend', resolve, {once: true}))
}
