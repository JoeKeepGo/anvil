export class BootstrapAlreadyCompletedError extends Error {
  constructor(message = "Bootstrap has already been completed.") {
    super(message)
    this.name = "BootstrapAlreadyCompletedError"
  }
}
