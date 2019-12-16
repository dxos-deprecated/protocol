//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';
import assert from 'assert';
import debug from 'debug';

import { Extension } from '@dxos/protocol';

import { Peer } from './peer';
import schema from './schema.json';

const log = debug('dxos.replicator');

const defaultIncoming = () => {};
const defaultSubscribe = () => () => {};

/**
 * Manages key exchange and feed replication.
 */
export class Replicator extends EventEmitter {
  static extension = 'dxos.protocol.replicator';

  /**
   * @param {Middleware} middleware
   * @param {Object} [options]
   * @param {number} [options.timeout=1000]
   */
  constructor (middleware, options) {
    assert(middleware);
    assert(middleware.load);

    const { load, subscribe = defaultSubscribe, incoming = defaultIncoming } = middleware;

    super();

    this._load = async (...args) => load(...args);
    this._subscribe = (...args) => subscribe(...args);
    this._incoming = async (...args) => incoming(...args);

    this._options = Object.assign({
      timeout: 1000
    }, options);

    this._peers = new Map();
  }

  toString () {
    const meta = {};

    return `Replicator(${JSON.stringify(meta)})`;
  }

  /**
   * Creates a protocol extension for key exchange.
   * @return {Extension}
   */
  createExtension () {
    return new Extension(Replicator.extension, {
      schema: JSON.parse(schema),
      timeout: this._options.timeout
    })
      .on('error', err => this.emit(err))
      .setHandshakeHandler(this._handshakeHandler.bind(this))
      .setMessageHandler(this._messageHandler.bind(this))
      .setCloseHandler(this._closeHandler.bind(this))
      .setFeedHandler(this._feedHandler.bind(this));
  }

  /**
   * Start replicating topics.
   *
   * @param {Protocol} protocol
   * @returns {Promise<void>}
   */
  async _handshakeHandler (protocol) {
    const extension = protocol.getExtension(Replicator.extension);

    const peer = new Peer(protocol, extension);

    this._peers.set(protocol, peer);

    const context = protocol.getContext();
    const session = protocol.getSession();

    try {
      const unsubscribe = this._subscribe((feed, metadata) => {
        if (metadata) {
          peer.share([{
            key: feed.key,
            metadata: Buffer.isBuffer(metadata) ? metadata : undefined
          }]).finally(() => {
            peer.replicate([feed]);
          });
          return;
        }

        peer.replicate([feed]);
      }, { context, session });
      peer.on('close', unsubscribe);

      const feeds = await this._load((...args) => peer.share(...args), { context, session }) || [];
      peer.replicate(feeds);
    } catch (err) {
      console.warn('Load error: ', err);
    }
  }

  /**
   * Handles key exchange requests.
   *
   * @param {Protocol} protocol
   * @param {Object} message
   */
  async _messageHandler (protocol, message) {
    const { type, data } = message;

    try {
      switch (type) {
        case 'share-feeds': {
          await this._incomingHandler(protocol, data || []);
          break;
        }

        default: {
          console.warn(`Invalid type: ${type}`);
        }
      }
    } catch (err) {
      console.warn('Message handler error', err);
    }
  }

  async _incomingHandler (protocol, data) {
    const peer = this._peers.get(protocol);
    const context = protocol.getContext();
    const session = protocol.getSession();

    try {
      const feeds = await this._incoming(data, { context, session }) || [];
      peer.replicate(feeds);
    } catch (err) {
      console.warn('Incoming feeds error', err);
    }
  }

  async _feedHandler (protocol, discoveryKey) {
    const peer = this._peers.get(protocol);
    const context = protocol.getContext();
    const session = protocol.getSession();

    try {
      const feeds = await this._incoming([{ discoveryKey }], { context, session }) || [];
      peer.replicate(feeds);
    } catch (err) {
      console.warn('Find feed error', err);
    }
  }

  _closeHandler (err, protocol) {
    log('replicator close', err);
    const peer = this._peers.get(protocol);
    peer._close();
    this._peers.delete(protocol);
  }
}
