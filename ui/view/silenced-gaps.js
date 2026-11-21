// Which of a run's `unsupported` entries the command line threw away.
//
// The terminal reports a gap on stderr and on the `unsupported` channel,
// which nothing in a command line can suppress — but a redirect, pipe or
// gate can discard stderr (`foo 2>/dev/null`: no output, no error, exit
// 127), leaving a run that hit a gap looking like one that found nothing.
// Those are worth surfacing; an entry whose message reached the transcript
// (either stream: `2>&1` moves a diagnostic, it doesn't silence it) is
// already on screen. Substring match: streams carry a trailing newline,
// and shell-level gaps an `error: ` prefix the entry's message omits.
export function silencedGaps({ stdout, stderr, unsupported }) {
  return unsupported
    .filter((gap) => !stderr.includes(gap.message) && !stdout.includes(gap.message))
    .map((gap) => gap.message)
}
