/**
 * Deciding which prompt started which turn, when restoring a conversation.
 *
 * Restore has to pair each completed job with the user message that triggered
 * it. It used to do that by POSITION — the N-th completed job to the N-th user
 * message — which is only sound while every user message starts exactly one
 * job. A mid-run steer (`POST /conversations/{id}/steer`) is a user message
 * that starts none, so it shifted every later turn onto the wrong prompt and
 * pushed the tail off the end of the loop entirely.
 *
 * The backend now stamps a turn's prompt with the same id the job records
 * (`job.message_id`), so the pairing can be exact. Four kinds of row show up in
 * the two lists, and the id is what tells them apart:
 *
 * | row                  | has message id | job links to it |
 * |----------------------|----------------|-----------------|
 * | current turn prompt  | yes            | yes             |
 * | mid-run steer        | yes            | no              |
 * | legacy prompt        | no             | n/a             |
 * | goal-continuation    | hidden from the message list entirely |
 *
 * Classification keys off whether a job's `message_id` actually MATCHES a
 * message — never off a field being present. Both are always populated in real
 * data: `jobs.message_id` is NOT NULL, and the messages endpoint substitutes a
 * positional index string when a row carries no id of its own. A presence check
 * therefore reads every pre-link conversation as linked and strips every prompt
 * bubble from it.
 *
 * So: a job whose id matches a message is a turn; a message no job claims is a
 * steer; a job past the cutover whose id matches nothing visible is a
 * continuation, replaying with no bubble (what the positional version did by
 * accident when it ran off the end of the message list).
 *
 * Jobs are the spine, so continuations keep their place in the transcript.
 * Steers are interleaved at the point they appear in the message list, which
 * puts them after the turn that was running when they were sent.
 *
 * A conversation can also be reopened while a turn is STILL RUNNING, and that
 * turn's prompt is paired here too (`runningJob`) even though its events are
 * not replayed from storage — they arrive on the live stream the caller
 * reconnects to. Only the pairing is special-cased; the walk treats it as an
 * ordinary turn.
 *
 * Jobs are the spine, which means a conversation can also have NO spine: every
 * job failed or was cancelled, or the only one is still running and the
 * active-job probe did not resolve it. The walk is then empty, and the prompts
 * are carried entirely by the message list — so they are emitted on their own
 * rather than dropped with the jobs that would have anchored them.
 *
 * A conversation predating the link has no `message_id` on any job; there is
 * nothing to pair with, and no backfill is possible — inferring which historic
 * prompt started which job is exactly the ambiguity the link removes, so
 * guessing would bake the bug into the data. Those fall back to the positional
 * walk, unchanged, and keep the old behaviour including its flaw.
 */

export interface RestoreJob {
  job_id: string;
  /** The prompt that started this turn. Absent on pre-link rows and on
   *  goal-continuation jobs, whose seed is hidden from the message list. */
  message_id?: string | null;
}

export interface RestoreMessage {
  /** Present once the backend tags prompts; absent on pre-link rows. */
  id?: string;
  content: string;
}

export type ReplayStep =
  /** Replay a job's events, optionally preceded by the prompt bubble. */
  | { kind: "turn"; jobId: string; content?: string; messageId?: string }
  /** A user message that started no turn — render the bubble alone. */
  | { kind: "steer"; content: string; messageId?: string };

/**
 * Order the replay: which jobs to play, with which prompts, and where the
 * steers go between them. Pure, so the ordering rules are testable without a
 * session, a network, or a fake event stream.
 */
export function planRestore(args: {
  completedJobs: RestoreJob[];
  /**
   * The turn that is still RUNNING, if one is. It joins the walk as an
   * ordinary turn so it is paired with its prompt by the same rules as any
   * other — the caller simply holds no events for it, because those are the
   * live stream it reconnects to, so the step renders the bubble alone.
   *
   * Without it a live turn's prompt is paired with nothing while still being
   * `claimed` (below), so it is neither a turn nor a steer and vanishes from
   * the restore entirely — leaving a conversation reopened mid-turn showing
   * the running turn's blocks under no prompt at all.
   */
  runningJob?: RestoreJob;
  /**
   * Message ids claimed by ANY job, not just completed ones. A steer is a
   * prompt no job started, so testing against completed jobs alone reads a
   * prompt whose turn is still RUNNING as a steer — and replays it as a
   * second, `steer`-flagged bubble on top of the one the live send already
   * rendered. Optional so callers that only have the completed set keep the
   * old behaviour.
   */
  claimedMessageIds?: (string | null | undefined)[];
  userMessages: RestoreMessage[];
}): ReplayStep[] {
  const { completedJobs, runningJob, userMessages } = args;
  // The running turn sits after every completed one, which is where it belongs
  // both chronologically and positionally: on a pre-link conversation the
  // fallback walk pairs it with `userMessages[completedJobs.length]`, the
  // prompt that follows the last completed turn's.
  const jobs = runningJob ? [...completedJobs, runningJob] : completedJobs;
  const claimed = new Set(
    (args.claimedMessageIds ?? jobs.map((j) => j.message_id)).filter(
      (id): id is string => !!id,
    ),
  );

  const byId = new Map<string, number>();
  userMessages.forEach((m, i) => {
    if (m.id) byId.set(m.id, i);
  });
  /** The message index this job's prompt lives at, if it is visible. */
  const linkOf = (j: RestoreJob): number | undefined =>
    j.message_id ? byId.get(j.message_id) : undefined;

  // `slice`, not `jobs`: the caller hands this a PORTION of the walk (the
  // pre-cutover head, or the whole list), and reusing the outer name for
  // sometimes-the-same list made `jobs` mean two things in one function.
  const positional = (
    slice: RestoreJob[],
    msgs: RestoreMessage[],
  ): ReplayStep[] =>
    slice.map((job, i) => ({
      kind: "turn" as const,
      jobId: job.job_id,
      content: msgs[i]?.content,
      messageId: msgs[i]?.id,
    }));

  /** A prompt no job claims: render the bubble on its own. */
  const isSteer = (m: RestoreMessage | undefined): m is RestoreMessage =>
    !!m?.id && !claimed.has(m.id);

  // No turn to walk AT ALL, which is not the same as a conversation with no
  // history. It is what a conversation looks like when its only job failed or
  // was cancelled (neither is `completed`, so neither reaches `completedJobs`),
  // or when the one still running was not resolved by the active-job probe.
  //
  // `positional` maps over JOBS, so it returns [] for an empty walk and the
  // whole transcript renders empty — the prompt the user actually sent
  // disappears, leaving the turn's blocks under nothing at all. There is no
  // positional pairing to preserve when there is nothing to pair with, and
  // nothing claims these messages (failed and cancelled jobs are deliberately
  // left out of `claimedMessageIds` for exactly this reason), so each renders
  // as its own bubble.
  //
  // Checked before `firstLinked`, because an empty list has no linked job by
  // definition and would otherwise fall into the pre-link branch below and
  // return [] from there.
  if (jobs.length === 0) {
    return userMessages.filter(isSteer).map((m) => ({
      kind: "steer" as const,
      content: m.content,
      messageId: m.id,
    }));
  }

  // Detection keys off whether a job's id actually MATCHES a message — never
  // off a field merely being present. Both fields are always populated in real
  // data (`jobs.message_id` is NOT NULL, and the messages endpoint substitutes
  // a positional index string when a row has no id of its own), so a
  // presence check silently classifies every pre-link conversation as linked
  // and strips every prompt bubble from it.
  const firstLinked = jobs.findIndex((j) => linkOf(j) !== undefined);
  if (firstLinked === -1) {
    // Nothing matches: the whole conversation predates the tagging.
    return positional(jobs, userMessages);
  }

  // The tagging started at a point in time, so a conversation spanning it
  // splits cleanly: everything before the first linked turn has no usable
  // link and falls back to position; everything after is exact.
  const cutover = linkOf(jobs[firstLinked]!)!;
  const steps: ReplayStep[] = positional(
    jobs.slice(0, firstLinked),
    userMessages.slice(0, cutover),
  );

  let cursor = cutover;

  /** Emit every steer sitting before `stopAt`, and advance past it. */
  const drainTo = (stopAt: number) => {
    while (cursor < stopAt) {
      const m = userMessages[cursor++];
      if (isSteer(m)) {
        steps.push({ kind: "steer", content: m.content, messageId: m.id });
      }
    }
    cursor = stopAt + 1;
  };

  for (const job of jobs.slice(firstLinked)) {
    const at = linkOf(job);
    if (at !== undefined) {
      drainTo(at);
      const prompt = userMessages[at]!;
      steps.push({
        kind: "turn",
        jobId: job.job_id,
        content: prompt.content,
        messageId: prompt.id,
      });
      continue;
    }
    // Past the cutover, a job whose id matches nothing visible is a goal
    // continuation: its seed is deliberately hidden from the message list, so
    // it replays its events with no bubble — which is what the positional
    // version did by accident when it ran off the end of the messages.
    steps.push({ kind: "turn", jobId: job.job_id });
  }

  // Steers sent during the final turn sit past every prompt.
  for (let i = cursor; i < userMessages.length; i++) {
    const m = userMessages[i];
    if (isSteer(m)) {
      steps.push({ kind: "steer", content: m.content, messageId: m.id });
    }
  }

  return steps;
}
