//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import { EventEmitter } from 'events';
import crypto from 'crypto';

import debug from 'debug';

import { keyToHuman } from './utils';
import { Codec } from './codec';
import { ProtocolError } from './protocol';

const log = debug('extension');

/**
 * Reliable message passing via using Dat protocol extensions.
 *
 * Events: "send", "receive", "error"
 */
export class Extension extends EventEmitter {
  /**
   * @type {Protocol}
   */
  _protocol = null;

  /**
   * Pending messages.
   * @type {Map<{id, Function}>}
   */
  _pendingMessages = new Map();

  /**
   * Handshake handler.
   * @type {Function<{protocol, context}>}
   */
  _handshakeHandler = null;

  /**
   * Close handler.
   * @type {Function<{protocol, context}>}
   */
  _closeHandler = null;

  /**
   * Message handler.
   * @type {Function<{protocol, context, message}>}
   */
  _messageHandler = null;

  /**
   * Feed handler.
   * @type {Function<{protocol, context, discoveryKey}>}
   */
  _feedHandler = null;

  _stats = {
    send: 0,
    receive: 0,
    error: 0
  };

  /**
   * @param {string} name
   * @param {Object} options
   * @param {Number} options.timeout
   * @param {Codec} options.codec
   */
  constructor (name, options = {}) {
    super();
    assert(typeof name === 'string' && name.length > 0, 'Name is required.');

    this._name = name;

    this._options = Object.assign({
      timeout: 2000,
      codec: new Codec({ binary: options.binary })
    }, options);
  }

  get name () {
    return this._name;
  }

  get stats () {
    return this._stats;
  }

  /**
   * Sets the handshake handler.
   * @param {Function<{protocol, context}>} handshakeHandler - Async handshake handler.
   * @returns {Extension}
   */
  setHandshakeHandler (handshakeHandler) {
    this._handshakeHandler = handshakeHandler;

    return this;
  }

  /**
   * Sets the close stream handler.
   * @param {Function<{protocol, context}>} closeHandler - Close handler.
   * @returns {Extension}
   */
  setCloseHandler (closeHandler) {
    this._closeHandler = closeHandler;

    return this;
  }

  /**
   * Sets the message handler.
   * @param {Function<{protocol, context, message}>} messageHandler - Async message handler.
   * @returns {Extension}
   */
  setMessageHandler (messageHandler) {
    this._messageHandler = messageHandler;

    return this;
  }

  /**
   * Sets the message handler.
   * @param {Function<{protocol, context, discoveryKey}>} feedHandler - Async feed handler.
   * @returns {Extension}
   */
  setFeedHandler (feedHandler) {
    this._feedHandler = feedHandler;

    return this;
  }

  /**
   * Initializes the extension.
   *
   * @param {Protocol} protocol
   */
  init (protocol) {
    assert(!this._protocol);
    log(`init[${this._name}]: ${keyToHuman(protocol.id)}`);

    this._protocol = protocol;
  }

  /**
   * Handshake event.
   *
   * @param {Object} context
   */
  onHandshake (context) {
    if (this._handshakeHandler) {
      this._handshakeHandler(this._protocol, context);
    }
  }

  /**
   * Close event.
   *
   * @param {Object} context
   */
  onClose (error, context) {
    if (this._closeHandler) {
      this._closeHandler(error, this._protocol, context);
    }
  }

  /**
   * Receives extension message.
   *
   * @param {Object} context
   * @param {Buffer} message
   */
  async onMessage (context, message) {
    const { id, error, data: requestData, options = {} } = this._options.codec.decode(message);

    // Check for a pending request.
    const idHex = id.toString('hex');

    const senderCallback = this._pendingMessages.get(idHex);
    if (senderCallback) {
      this._pendingMessages.delete(idHex);
      senderCallback(context, requestData, error);
      return;
    }

    if (!this._messageHandler) {
      console.warn('No message handler.');
      this.emit('error', new ProtocolError(500, 'No message handler'));
      return;
    }

    try {
      // Process the message.
      log(`received ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(id, 'msg')}`);
      const responseData = await this._messageHandler(this._protocol, context, requestData);

      if (options.oneway) {
        return;
      }

      // Send the response.
      const response = { id, data: responseData };
      log(`responding ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(id, 'msg')}`);
      this._protocol.feed.extension(this._name, this._options.codec.encode(response));
    } catch (ex) {
      if (options.oneway) {
        return;
      }

      // System error.
      const code = (ex instanceof ProtocolError) ? ex.code : 500;
      const response = { id, error: { code, error: ex.message } };
      this._protocol.feed.extension(this._name, this._options.codec.encode(response));
    }
  }

  /**
   * Feed event.
   *
   * @param {Object} context
   * @param {Buffer} discoveryKey
   */
  onFeed (context, discoveryKey) {
    if (this._feedHandler) {
      this._feedHandler(this._protocol, context, discoveryKey);
    }
  }

  /**
   * Sends a message to peer.
   * @param {Object} message
   * @param {Object} options
   * @param {Boolean} options.oneway
   * @returns {Promise<Object>} Response from peer.
   */
  async send (message, options = {}) {
    const { oneway = false } = options;

    const request = {
      id: crypto.randomBytes(32),
      data: message,
      options: {
        oneway
      }
    };

    // Send the message.
    // TODO(burdon): Is it possible to have a stream event, where retrying would be appropriate?
    this._send(request);

    if (oneway) {
      return;
    }

    // Trigger the callback.
    const promise = {};

    // Set the callback to be called when the response is received.
    this._pendingMessages.set(request.id.toString('hex'), async (context, response, error) => {
      log(`response ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(request.id, 'msg')}`);
      this._stats.receive++;
      this.emit('receive', this._stats);
      promise.done = true;

      if (error) {
        promise.reject(error);
        return;
      }

      if (promise.expired) {
        console.warn('Timed out.');
        this.emit('error', new ProtocolError(408));
        return;
      }

      promise.resolve({ context, response });
    });

    return new Promise((resolve, reject) => {
      promise.resolve = resolve;
      promise.reject = reject;

      // Set timeout.
      if (this._options.timeout) {
        setTimeout(() => {
          if (!promise.done) {
            promise.expired = true;
            this._stats.error++;
            reject({ code: 408 }); // eslint-disable-line
          }
        }, this._options.timeout);
      }
    });
  }

  /**
   * Sends a extension message.
   *
   * @param {Buffer} message
   * @returns {Boolean}
   */
  _send (request) {
    log(`sending a message ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(request.id, 'msg')}`);
    this._protocol.feed.extension(this._name, this._options.codec.encode(request));

    this._stats.send++;
    this.emit('send', this._stats);
  }
}
