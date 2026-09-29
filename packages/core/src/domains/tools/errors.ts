export class ActionRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ActionRejectedError";
  }
}
