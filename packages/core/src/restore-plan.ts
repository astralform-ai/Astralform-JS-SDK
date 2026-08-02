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
 * So: an id that a job claims is a turn; an id no job claims is a steer; a
 * message with no id at all is from before the link existed and falls back to
 * being consumed positionally; and a job whose `message_id` matches nothing
 * visible is a continuation, which replays its events with no bubble of its own
 * (that is what the positional version did by accident, when it ran off the end
 * of the message list and passed `undefined`).
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

  // Nothing to pair against: every job predates the link. Keep the old
  // positional walk rather than silently dropping every prompt bubble.
  if (completedJobs.every((j) => !j.message_id)) {
    return completedJobs.map((job, i) => ({
      kind: "turn" as const,
      jobId: job.job_id,
      content: userMessages[i]?.content,
      messageId: userMessages[i]?.id,
    }));
  }

  const byId = new Map<string, RestoreMessage>();
  for (const m of userMessages) if (m.id) byId.set(m.id, m);

  const steps: ReplayStep[] = [];
  // Walks the message list alongside the jobs, so steers are emitted at the
  // position they actually occupy rather than swept to the end.
  let cursor = 0;

  /** Emit every steer sitting before `stopAt`, and advance past it. */
  const isSteer = (m: RestoreMessage | undefined): m is RestoreMessage =>
    !!m?.id && !completedJobs.some((j) => j.message_id === m.id);

  const drainTo = (stopAt: number) => {
    while (cursor < stopAt) {
      const m = userMessages[cursor++];
      // An id no job claimed: the user sent it mid-run, so it started no turn.
      if (isSteer(m)) {
        steps.push({ kind: "steer", content: m.content, messageId: m.id });
      }
    }
    cursor = stopAt + 1;
  };

  for (const job of completedJobs) {
    const prompt = job.message_id ? byId.get(job.message_id) : undefined;
    if (prompt) {
      drainTo(userMessages.indexOf(prompt));
      steps.push({
        kind: "turn",
        jobId: job.job_id,
        content: prompt.content,
        messageId: prompt.id,
      });
      continue;
    }
    // No visible prompt. Either a pre-link job in a conversation that also has
    // newer ones — consume the next id-less message, which is what a pre-link
    // prompt looks like — or a goal continuation, whose seed is hidden and
    // which therefore replays with no bubble.
    const legacy = userMessages.findIndex((m, i) => i >= cursor && !m.id);
    const legacyMessage = legacy === -1 ? undefined : userMessages[legacy];
    if (!job.message_id && legacyMessage) {
      drainTo(legacy);
      steps.push({
        kind: "turn",
        jobId: job.job_id,
        content: legacyMessage.content,
      });
      continue;
    }
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
