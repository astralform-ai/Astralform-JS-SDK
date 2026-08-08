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
  userMessages: RestoreMessage[];
}): ReplayStep[] {
  const { completedJobs, userMessages } = args;

  const byId = new Map<string, number>();
  userMessages.forEach((m, i) => {
    if (m.id) byId.set(m.id, i);
  });
  /** The message index this job's prompt lives at, if it is visible. */
  const linkOf = (j: RestoreJob): number | undefined =>
    j.message_id ? byId.get(j.message_id) : undefined;

  const positional = (
    jobs: RestoreJob[],
    msgs: RestoreMessage[],
  ): ReplayStep[] =>
    jobs.map((job, i) => ({
      kind: "turn" as const,
      jobId: job.job_id,
      content: msgs[i]?.content,
      messageId: msgs[i]?.id,
    }));

  // Detection keys off whether a job's id actually MATCHES a message — never
  // off a field merely being present. Both fields are always populated in real
  // data (`jobs.message_id` is NOT NULL, and the messages endpoint substitutes
  // a positional index string when a row has no id of its own), so a
  // presence check silently classifies every pre-link conversation as linked
  // and strips every prompt bubble from it.
  const firstLinked = completedJobs.findIndex((j) => linkOf(j) !== undefined);
  if (firstLinked === -1) {
    // Nothing matches: the whole conversation predates the tagging.
    return positional(completedJobs, userMessages);
  }

  // The tagging started at a point in time, so a conversation spanning it
  // splits cleanly: everything before the first linked turn has no usable
  // link and falls back to position; everything after is exact.
  const cutover = linkOf(completedJobs[firstLinked]!)!;
  const steps: ReplayStep[] = positional(
    completedJobs.slice(0, firstLinked),
    userMessages.slice(0, cutover),
  );

  let cursor = cutover;
  const isSteer = (m: RestoreMessage | undefined): m is RestoreMessage =>
    !!m?.id && !completedJobs.some((j) => j.message_id === m.id);

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

  for (const job of completedJobs.slice(firstLinked)) {
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
