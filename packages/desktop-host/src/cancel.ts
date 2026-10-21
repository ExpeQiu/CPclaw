export type RunControl = {
  status: "idle" | "running" | "cancelling" | "cancelled";
  allowNewCalls: boolean;
  pendingPaths: string[];
};

export function createRunControl(): RunControl {
  return { status: "idle", allowNewCalls: true, pendingPaths: [] };
}

export function beginCall(control: RunControl): { ok: true } | { ok: false; code: "CANCELLED"; message: string } {
  if (!control.allowNewCalls || control.status === "cancelling" || control.status === "cancelled") {
    return { ok: false, code: "CANCELLED", message: "取消后不再发起新调用" };
  }
  control.status = "running";
  return { ok: true };
}

export function noteWrittenPath(control: RunControl, filePath: string): void {
  control.pendingPaths.push(filePath);
}

export function cancelRun(control: RunControl): void {
  control.status = "cancelling";
  control.allowNewCalls = false;
}

export function finishCancel(control: RunControl): { status: "reconcile_required"; pendingPaths: string[] } {
  control.status = "cancelled";
  control.allowNewCalls = false;
  return { status: "reconcile_required", pendingPaths: [...control.pendingPaths] };
}
