//
// Copyright 2020 DxOS.
//

/**
 * Protocol error with HTTP-like codes.
 * https://en.wikipedia.org/wiki/List_of_HTTP_status_codes
 */
export class ProtocolError extends Error {
  constructor (code, message) {
    super(message);
    this.code = code;
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = (new Error(message)).stack;
    }
  }

  toString () {
    const parts = [this.code];
    if (this.message) { parts.push(this.message); }
    return `ProtocolError(${parts.join(', ')})`;
  }
}
