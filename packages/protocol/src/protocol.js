//
// Copyright 2019 DxOS.
//

import assert from 'assert';

import debug from 'debug';
import protocol from 'hypercore-protocol';
import eos from 'end-of-stream';
import bufferJson from 'buffer-json-encoding';
import { NanoresourcePromise } from 'nanoresource-promise/emitter';

import { ExtensionInit } from './extension-init';
import { keyToHuman } from './utils';
import {
  ERR_PROTOCOL_CONNECTION_INVALID,
  ERR_PROTOCOL_HANDSHAKE_FAILED,
  ERR_PROTOCOL_EXTENSION_MISSING
} from './errors';

const log = debug('dxos:protocol');

/**
 * Wraps a hypercore-protocol object.
 */
export class Protocol extends NanoresourcePromise {
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

    this._extensionInit = new ExtensionInit({ timeout: this._initTimeout });

    this._init = false;

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
    this._handshakes.push(async (protocol) => {
      try {
        await handler(protocol);
      } catch (err) {
        throw new ERR_PROTOCOL_HANDSHAKE_FAILED(err.message);
      }
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

    this._init = true;
    this._discoveryKey = discoveryKey;
    this.open().catch(err => this.emit('error', err));

    return this;
  }

  async _open () {
    await this._openExtensions();

    // Handshake.
    this._stream.once('handshake', async () => {
      try {
        await this._initExtensions();
        this.emit('extensions-initialized');
        await this._handshakeExtensions();
        this.emit('extensions-handshake');
      } catch (err) {
        this._stream.destroy();
        this.emit('error', err);
      }
    });

    this._openConnection();

    eos(this._stream, () => {
      this.close();
    });

    log(keyToHuman(this._stream.id, 'node'), 'initialized');
  }

  async _close () {
    this._stream.destroy();
    await this._extensionInit.close().catch(err => this.emit('error', err));
    for (const [name, extension] of this._extensionMap) {
      log(`close extension "${name}"`);
      await extension.close().catch(err => this.emit('error', err));
    }
  }

  async _openExtensions () {
    await this._extensionInit.openWithProtocol(this);

    const sortedExtensions = [this._extensionInit.name];

    for (const [name, extension] of this._extensionMap) {
      log(`open extension "${name}": ${keyToHuman(this._stream.id, 'node')}`);
      await extension.openWithProtocol(this);
      sortedExtensions.push(name);
    }

    sortedExtensions.sort().forEach(name => {
      this._stream.extensions.push(name);
    });
  }

  async _initExtensions () {
    try {
      for (const [name, extension] of this._extensionMap) {
        log(`init extension "${name}": ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
        await extension.onInit();
      }

      await this._extensionInit.continue();
    } catch (err) {
      await this._extensionInit.break();

      throw err;
    }
  }

  async _handshakeExtensions () {
    for (const handshake of this._handshakes) {
      await handshake(this);
    }

    for (const [name, extension] of this._extensionMap) {
      log(`handshake extension "${name}": ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
      await extension.onHandshake();
    }

    log(`handshake: ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
    this.emit('handshake', this);

    this._stream.on('feed', async (discoveryKey) => {
      try {
        for (const [name, extension] of this._extensionMap) {
          log(`feed extension "${name}": ${keyToHuman(this._stream.id)} <=> ${keyToHuman(this._stream.remoteId)}`);
          await extension.onFeed(discoveryKey);
        }
      } catch (err) {
        this.emit('error', err);
      }
    });
  }

  _openConnection () {
    let initialKey = null;

    const openFeed = async (discoveryKey) => {
      try {
        initialKey = await this._discoveryToPublicKey(discoveryKey);
        if (!initialKey) {
          throw new ERR_PROTOCOL_CONNECTION_INVALID('key not found');
        }

        // init stream
        this._feed = this._stream.feed(initialKey);
        this._feed.on('extension', this._extensionHandler);
      } catch (err) {
        if (ERR_PROTOCOL_CONNECTION_INVALID.equals(err)) {
          this.emit('error', err);
        } else {
          this.emit('error', new ERR_PROTOCOL_CONNECTION_INVALID(err.message));
        }
        this._stream.destroy();
      }
    };

    // If this protocol stream is being created via a swarm connection event,
    // only the client side will know the topic (i.e. initial feed key to share).
    if (this._discoveryKey) {
      openFeed(this._discoveryKey);
    } else {
      // Wait for the peer to share the initial feed and see if we have the public key for that.
      this._stream.once('feed', openFeed);
    }
  }

  /**
   * Handles extension messages.
   */
  _extensionHandler = (name, message) => {
    if (name === this._extensionInit.name) {
      this._extensionInit.emit('extension-message', message);
      return;
    }

    const extension = this._extensionMap.get(name);
    if (!extension) {
      this.emit('error', new ERR_PROTOCOL_EXTENSION_MISSING(name));
      this._stream.destroy();
      return;
    }

    extension.emit('extension-message', message);
  }
}
