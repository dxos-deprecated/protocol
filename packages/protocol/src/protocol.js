//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';
import assert from 'assert';

import debug from 'debug';
import protocol from 'hypercore-protocol';
import eos from 'end-of-stream';
import bufferJson from 'buffer-json-encoding';

import { ExtensionInit } from './extension-init';
import { keyToHuman } from './utils';

const log = debug('dxos:protocol');

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
   * Local object to store data for extensions.
   * @type {Object}
   */
  _context = {}

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

    const { discoveryToPublicKey = key => key, streamOptions, initTimeout = 5 * 1000 } = options;

    this._discoveryToPublicKey = discoveryToPublicKey;

    this._streamOptions = streamOptions;

    this._initTimeout = initTimeout;

    this._stream = protocol(this._streamOptions);

    this._init = false;
    this._handshakeValidated = false;

    this._handshakes = [];
    this.on('error', error => {
      log(error);
    });
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
   * Sets session data which is exchanged with the peer during the handshake.
   * @param {Object} data
   * @returns {Protocol}
   */
  setSession (data) {
    this._stream.userData = bufferJson.encode(data);

    return this;
  }

  /**
   * Get remote session data.
   * @returns {{}}
   */
  getSession () {
    try {
      return bufferJson.decode(this._stream.remoteUserData);
    } catch (err) {
      return {};
    }
  }

  /**
   * Set local context.
   * @returns {Protocol}
   */
  setContext (context) {
    this._context = Object.assign({}, context);

    return this;
  }

  /**
   * Get local context.
   * @returns {{}}
   */
  getContext () {
    return this._context;
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
    this._handshakes.push(handler);
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

    this._init = true;

    this._extensionInit = new ExtensionInit({ timeout: this._initTimeout });
    this._extensionInit.init(this);

    // Initialize extensions.
    const sortedExtensions = [this._extensionInit.name];
    this._extensionMap.forEach(extension => {
      sortedExtensions.push(extension.name);
      extension.init(this);
    });

    sortedExtensions.sort().forEach(name => {
      this._stream.extensions.push(name);
    });

    // Handshake.
    this._stream.once('handshake', async () => {
      try {
        for (const [name, extension] of this._extensionMap) {
          if (this._stream.destroyed) {
            return;
          }

          log(`init extension "${name}": ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
          await extension.onInit();
        }

        if (!(await this._extensionInit.continue())) {
          throw new Error('invalid init protocol');
        }

        for (const handshake of this._handshakes) {
          if (this._stream.destroyed) {
            return;
          }

          await handshake(this);
        }

        for (const [name, extension] of this._extensionMap) {
          if (this._stream.destroyed) {
            return;
          }

          log(`handshake extension "${name}": ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
          await extension.onHandshake();
        }

        if (this._stream.destroyed) {
          return;
        }

        log(`handshake: ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
        this.emit('handshake', this);
      } catch (err) {
        this._extensionInit.break()
          .finally(() => {
            process.nextTick(() => {
              err.code = 'ERR_ON_HANDSHAKE';
              this._stream.destroy(err);
              this.emit('error', err);
            });
          });
        return;
      }

      this._stream.on('feed', (discoveryKey) => {
        try {
          this._extensionMap.forEach((extension) => {
            extension.onFeed(discoveryKey);
          });
        } catch (err) {
          err.code = 'ERR_ON_FEED';
          this.emit('error', err);
        }
      });
    });

    let initialKey = null;

    // If this protocol stream is being created via a swarm connection event,
    // only the client side will know the topic (i.e. initial feed key to share).
    if (discoveryKey) {
      initialKey = this._discoveryToPublicKey(discoveryKey);
      if (!initialKey) {
        this.emit('error',
          new Error(`init:stream:feed - Public key not found for discovery key: ${keyToHuman(this._stream.id, 'node')} ${keyToHuman(discoveryKey)}`)
        );
      }
      this._initStream(initialKey);
    } else {
      // Wait for the peer to share the initial feed and see if we have the public key for that.
      this._stream.once('feed', async (discoveryKey) => {
        initialKey = this._discoveryToPublicKey(discoveryKey);

        if (!initialKey) {
          // Stream will get aborted soon as both sides haven't shared the same initial Dat feed.
          this.emit('error',
            new Error(`init:stream:feed - Public key not found for discovery key: ${keyToHuman(this._stream.id, 'node')} ${keyToHuman(discoveryKey)}`)
          );

          return;
        }

        if (this._feed) {
          return;
        }

        this._initStream(initialKey);
      });
    }

    eos(this._stream, (err) => {
      this._extensionInit.onClose();
      this._extensionMap.forEach((extension) => {
        extension.onClose(err);
      });
    });

    log(keyToHuman(this._stream.id, 'node'), 'initialized');
    return this;
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
    if (name === this._extensionInit.name) {
      return this._extensionInit.onMessage(message);
    }

    const extension = this._extensionMap.get(name);
    if (!extension) {
      this.emit('error', new Error(`Missing extension: ${name}`));
      return;
    }

    await extension.onMessage(message);
  }
}
