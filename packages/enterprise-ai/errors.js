export class EnterpriseAiError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'EnterpriseAiError'; this.code = code; this.status = status
  }
}
