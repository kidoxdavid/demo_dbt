export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
