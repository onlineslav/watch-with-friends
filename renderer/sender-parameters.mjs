// Reads a sender's parameters, lets `edit` change them, and sets them. The read happens right before the set: a
// renegotiation that lands between the two (a viewer joining, a rejoin over a kept connection) changes what the
// browser compares against (the RTCP parameters, the transaction id) and rejects the set with
// InvalidModificationError ("Attempted to set RtpParameters with modified RTCP parameters", seen once on 0.8.0), so
// that one failure re-reads and tries again before it counts; the once-a-second tuning pass is the backstop after that.
// `first`: parameters the caller already read in the same tick, used for the first try.
export async function applySenderParameters(sender, edit, first = null) {
  for (let attempt = 0; ; attempt++) {
    const params = attempt || !first ? sender.getParameters() : first
    if (!edit(params)) return {changed: false, retried: attempt > 0}
    try {
      await sender.setParameters(params)
      return {changed: true, retried: attempt > 0}
    } catch (error) {
      if (error?.name !== 'InvalidModificationError' || attempt >= 1) throw error
    }
  }
}
