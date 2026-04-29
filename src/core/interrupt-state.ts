export type InterruptHint = "resume" | "force-stop" | "exit";
export type InterruptDisposition =
  | "request-graceful-stop"
  | "force-stop"
  | "exit";

type InterruptStateSnapshot = {
  status: "running" | "waiting" | "aborted" | "stopped";
  gracefulStopRequested: boolean;
};

export function getInterruptDisposition(
  state: InterruptStateSnapshot,
): InterruptDisposition {
  if (state.status === "aborted") {
    return "exit";
  }
  if (state.gracefulStopRequested || state.status === "stopped") {
    return "force-stop";
  }
  return "request-graceful-stop";
}

export function getInterruptHint(state: InterruptStateSnapshot): InterruptHint {
  const disposition = getInterruptDisposition(state);
  if (disposition === "exit") {
    return "exit";
  }
  if (disposition === "force-stop") {
    return "force-stop";
  }
  return "resume";
}
