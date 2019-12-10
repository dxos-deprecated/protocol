//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';
import assert from 'assert';

import debug from 'debug';
import protocol from 'hypercore-protocol';
import eos from 'end-of-stream';

import { keyToHuman } from './utils';

const log = debug('protocol');

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

/**
 * Wraps a hypercore-protocol object.
 */
export class Protocol extends EventEmitter {
  /**
   * Protocol extensions.
   * @type {Map<type, Extension>}
   */
  _extensionMap = new Map();

  /**
   * https://github.com/mafintosh/hypercore-protocol
   * @type {{ on, once, feed, remoteId, remoteUserData }}
   */
  _stream = undefined;

  /**
   * https://github.com/mafintosh/hypercore-protocol#var-feed--streamfeedkey
   * @type {Feed}
   */
  _feed = undefined;

  /**
   * @constructor
   *
   * @param {Object} options
   * @param {Object} options.streamOptions - https://github.com/mafintosh/hypercore-protocol#var-stream--protocoloptions
   * @param {Buffer} [options.streamOptions.id=randomBytes(32)] - You can use this to detect if you connect to yourself.
   * @param {Boolean} [options.streamOptions.live=false] - Signal to the other peer that you want to keep this stream open forever.
   * @param {Number} [options.streamOptions.expectedFeeds=0] - How many feeds I expect to be sync before close the stream.
   * @param {Function<{discoveryKey}>} options.discoveryToPublicKey - Match the discoveryKey with a publicKey to do the handshake.
   * @param {Codec} options.codec - Define a codec to encode/decode messages from extensions.
   */
  constructor (options = {}) {
    super();

    // TODO(ashwin): Check Codec() only called when the option is null.
    const { discoveryToPublicKey = key => key, streamOptions } = options;

    this._discoveryToPublicKey = discoveryToPublicKey;

    this._streamOptions = streamOptions;

    this._stream = protocol(this._streamOptions);

    this._init = false;
  }

  toString () {
    const meta = {
      id: keyToHuman(this._stream.id),
      extensions: Array.from(this._extensionMap.keys())
    };

    return `Protocol(${JSON.stringify(meta)})`;
  }

  get id () {
    return this._stream.id;
  }

  get stream () {
    return this._stream;
  }

  get feed () {
    return this._feed;
  }

  get extensions () {
    return Array.from(this._extensionMap.values());
  }

  get streamOptions () {
    return Object.assign({}, { id: this._stream.id }, this._streamOptions);
  }

  /**
   * Sets user data which is exchanged with the peer during the handshake.
   * @param {Object} data
   * @returns {Protocol}
   */
  setUserData (data) {
    this._stream.userData = Buffer.from(JSON.stringify(data));

    return this;
  }

  /**
   * Sets the named extension.
   * @param {{ name, init, onMessage }} extension
   * @returns {Protocol}
   */
  setExtension (extension) {
    assert(extension);
    this._extensionMap.set(extension.name, extension);

    return this;
  }

  /**
   * Sets the set of extensions.
   * @param {[{ name, handler }]} extensions
   * @returns {Protocol}
   */
  setExtensions (extensions) {
    extensions.forEach(extension => this.setExtension(extension));

    return this;
  }

  /**
   * Returns the extension by name.
   * @param {string} name
   * @returns {Object} extension object.
   */
  getExtension (name) {
    return this._extensionMap.get(name);
  }

  /**
   * Set protocol handshake handler.
   * @param {Function<{protocol}>} handler - Async handshake handler.
   * @returns {Protocol}
   */
  setHandshakeHandler (handler) {
    this.once('handshake', async () => {
      await handler(this);
    });

    return this;
  }

  /**
   * Initializes the protocol stream, creating a feed.
   *
   * https://github.com/mafintosh/hypercore-protocol
   *
   * @param {Buffer} [discoveryKey]
   * @returns {Protocol}
   */
  init (discoveryKey) {
    assert(!this._init);

    // TODO(ashwin): Set at end of function (we might crash).
    this._init = true;

    // See https://github.com/wirelineio/wireline-core/blob/master/docs/design/appendix.md#swarming--dat-protocol-handshake for details.

    // Initialize extensions.
    this._extensionMap.forEach((extension) => {
      this._stream.extensions.push(extension.name);
      extension.init(this);
    });

    // Handshake.
    this._stream.once('handshake', async () => {
      const context = this.getContext();

      try {
        for (const [name, extension] of this._extensionMap) {
          // TODO(ashwin): Why is stream.destroyed checked inside the extension loop?
          // TODO(ashwin): Also, consider logging/warn when existing due to some unexpected condition.
          if (this._stream.destroyed) {
            return;
          }

          log(`handshake extension "${name}": ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
          await extension.onHandshake(context);
        }

        if (this._stream.destroyed) {
          return;
        }

        log(`handshake: ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
        this.emit('handshake', this);
      } catch (err) {
        this._stream.destroy();
        console.warn(err);
      }

      this._stream.on('feed', (discoveryKey) => {
        try {
          // We wait for the protocol initialization handshake before start sharing feeds.
          const context = this.getContext();

          this._extensionMap.forEach((extension) => {
            extension.onFeed(context, discoveryKey);
          });
        } catch (err) {
          console.warn(err);
        }
      });
    });

    let initialKey = null;

    // If this protocol stream is being created via a swarm connection event,
    // only the client side will know the topic (i.e. initial feed key to share).
    if (discoveryKey) {
      initialKey = this._discoveryToPublicKey(discoveryKey);
      if (!initialKey) {
        // Continuing onward to initialize the stream without a key will fail, but the error thrown then
        // is as apt as any we would construct and throw here, so we simply report the condition.
        console.error('init - Public key not found for discovery key: ', keyToHuman(this._stream.id, 'node'), keyToHuman(discoveryKey));
      }
      this._initStream(initialKey);
    } else {
      // Wait for the peer to share the initial feed and see if we have the public key for that.
      this._stream.once('feed', async (discoveryKey) => {
        initialKey = this._discoveryToPublicKey(discoveryKey);

        if (!initialKey) {
          // Stream will get aborted soon as both sides haven't shared the same initial Dat feed.
          console.warn('init:stream:feed - Public key not found for discovery key: ', keyToHuman(this._stream.id, 'node'), keyToHuman(discoveryKey));

          return;
        }

        if (this._feed) {
          console.warn('Protocol already initialized.');
          return;
        }

        this._initStream(initialKey);
      });
    }

    eos(this._stream, (err) => {
      const context = this.getContext();

      this._extensionMap.forEach((extension) => {
        extension.onClose(err, context);
      });
    });

    log(keyToHuman(this._stream.id, 'node'), 'initialized');
    return this;
  }

  /**
   * Get context.
   * @returns {{}}
   */
  getContext () {
    try {
      return JSON.parse(this._stream.remoteUserData);
    } catch (err) {
      return {};
    }
  }

  /**
   * Init Dat stream by sharing the same initial feed key.
   * https://datprotocol.github.io/how-dat-works/#feed-message
   * @param key
   * @private
   */
  _initStream (key) {
    this._feed = this._stream.feed(key);
    this._feed.on('extension', this._extensionHandler);
  }

  /**
   * Handles extension messages.
   */
  _extensionHandler = async (name, message) => {
    const extension = this._extensionMap.get(name);
    if (!extension) {
      console.warn(`Missing extension: ${name}`);
      this.emit('error');
      return;
    }

    await extension.onMessage(this.getContext(), message);
  }
}
