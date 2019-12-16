//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import debug from 'debug';

import { Codec } from '@dxos/codec-protobuf';

import { keyToHuman } from './utils';
import { ProtocolError } from './protocol';
import schema from './schema.json';

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
   * @type {Function<{protocol}>}
   */
  _handshakeHandler = null;

  /**
   * Close handler.
   * @type {Function<{protocol}>}
   */
  _closeHandler = null;

  /**
   * Message handler.
   * @type {Function<{protocol, message}>}
   */
  _messageHandler = null;

  /**
   * Feed handler.
   * @type {Function<{protocol, discoveryKey}>}
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
   */
  constructor (name, options = {}) {
    super();
    assert(typeof name === 'string' && name.length > 0, 'name is required.');

    this._name = name;

    this._options = Object.assign({
      timeout: 2000
    }, options);

    this._codec = new Codec('dxos.protocol.Message')
      .addJson(JSON.parse(schema));

    if (this._options.schema) {
      this._codec.addJson(this._options.schema);
    }

    this._codec.build();
  }

  get name () {
    return this._name;
  }

  get stats () {
    return this._stats;
  }

  /**
   * Sets the handshake handler.
   * @param {Function<{protocol}>} handshakeHandler - Async handshake handler.
   * @returns {Extension}
   */
  setHandshakeHandler (handshakeHandler) {
    this._handshakeHandler = handshakeHandler;

    return this;
  }

  /**
   * Sets the close stream handler.
   * @param {Function<{protocol}>} closeHandler - Close handler.
   * @returns {Extension}
   */
  setCloseHandler (closeHandler) {
    this._closeHandler = closeHandler;

    return this;
  }

  /**
   * Sets the message handler.
   * @param {Function<{protocol, message}>} messageHandler - Async message handler.
   * @returns {Extension}
   */
  setMessageHandler (messageHandler) {
    this._messageHandler = messageHandler;

    return this;
  }

  /**
   * Sets the message handler.
   * @param {Function<{protocol, discoveryKey}>} feedHandler - Async feed handler.
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
   */
  onHandshake () {
    if (this._handshakeHandler) {
      this._handshakeHandler(this._protocol);
    }
  }

  /**
   * Close event.
   */
  onClose (error) {
    if (this._closeHandler) {
      this._closeHandler(error, this._protocol);
    }
  }

  /**
   * Receives extension message.
   *
   * @param {Buffer} message
   */
  async onMessage (message) {
    const { id, error, data: requestData, options = {} } = this._codec.decode(message);

    // Check for a pending request.
    const idHex = id.toString('hex');

    const senderCallback = this._pendingMessages.get(idHex);
    if (senderCallback) {
      this._pendingMessages.delete(idHex);
      senderCallback(requestData, error);
      return;
    }

    if (!this._messageHandler) {
      console.warn('No message handler.');
      this.emit('error', new ProtocolError('ERR_SYSTEM', 'No message handler'));
      return;
    }

    try {
      // Process the message.
      log(`received ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(id, 'msg')}`);
      let responseData = await this._messageHandler(this._protocol, requestData, options);
      responseData = Buffer.isBuffer(responseData) ? { __type_url: 'Buffer', data: responseData } : responseData;

      if (options.oneway) {
        return;
      }

      // Send the response.
      const response = { id, data: responseData };
      log(`responding ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(id, 'msg')}`);
      this._protocol.feed.extension(this._name, this._codec.encode(response));
    } catch (err) {
      if (options.oneway) {
        return;
      }

      // System error.
      const code = (err instanceof ProtocolError) ? err.code : 'ERR_SYSTEM';
      const response = { id, error: { code: code, message: err.message } };
      this._protocol.feed.extension(this._name, this._codec.encode(response));
    }
  }

  /**
   * Feed event.
   *
   * @param {Buffer} discoveryKey
   */
  onFeed (discoveryKey) {
    if (this._feedHandler) {
      this._feedHandler(this._protocol, discoveryKey);
    }
  }

  /**
   * Sends a message to peer.
   * @param {(Object|Buffer)} message
   * @param {Object} options
   * @param {Boolean} options.oneway
   * @returns {Promise<Object>} Response from peer.
   */
  async send (message, options = {}) {
    assert(typeof message === 'object' || Buffer.isBuffer(message));

    const { oneway = false } = options;

    const request = {
      id: crypto.randomBytes(32),
      data: Buffer.isBuffer(message) ? { __type_url: 'dxos.protocol.Buffer', data: message } : message,
      options: {
        oneway
      }
    };

    // Send the message.
    this._send(request);

    if (oneway) {
      return;
    }

    // Trigger the callback.
    const promise = {};

    // Set the callback to be called when the response is received.
    this._pendingMessages.set(request.id.toString('hex'), async (response, error) => {
      log(`response ${keyToHuman(this._protocol.stream.id, 'node')}: ${keyToHuman(request.id, 'msg')}`);
      this._stats.receive++;
      this.emit('receive', this._stats);
      promise.done = true;

      if (error) {
        promise.reject(error);
        return;
      }

      if (promise.expired) {
        this.emit('error', new ProtocolError('ERR_REQUEST_TIMEOUT'));
        return;
      }

      promise.resolve({ response });
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
            reject({ code: 'ERR_REQUEST_TIMEOUT' }); // eslint-disable-line
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
    this._protocol.feed.extension(this._name, this._codec.encode(request));

    this._stats.send++;
    this.emit('send', this._stats);
  }
}
