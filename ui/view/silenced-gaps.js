// Which of a run's `unsupported` entries the command line threw away.
//
// The terminal reports a gap twice over: on stderr, where an
// interactive user reads it, and on the `unsupported` channel, which
// nothing in a command line can suppress. Usually that is one message
// in two places and the transcript already shows it. But stderr
// belongs to the command, so a redirect, a pipe, a gate or a subshell
// is free to discard it — and then a run that hit a gap is
// indistinguishable from one that simply found nothing:
//
//   foo 2>/dev/null          no output, no error, and exit 127
//   ls --bogus 2>/dev/null   an unknown option, reported to no one
//
// Those are the ones worth surfacing. An entry whose message reached
// the transcript is left out: it is already on screen, and a hint
// would only say the same thing twice, in a smaller font.
//
// Both streams count as the transcript, because both are rendered.
// `2>&1` does not silence a diagnostic, it moves it: `foo 2>&1` leaves
// stderr empty while the message sits in stdout, in plain view. Only
// once something downstream drops it — `foo 2>&1 | grep -c x`, whose
// stdout is a count — is there nothing left to read.
//
// Substring rather than equality because a stream carries the message
// with a trailing newline, and shell-level gaps additionally carry a
// generic `error: ` prefix that the entry's own message omits.
export function silencedGaps({ stdout, stderr, unsupported }) {
  return unsupported
    .filter((gap) => !stderr.includes(gap.message) && !stdout.includes(gap.message))
    .map((gap) => gap.message)
}
