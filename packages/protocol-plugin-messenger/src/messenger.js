//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';
import assert from 'assert';

import { Codec } from '@dxos/codec-protobuf';
import { Broadcast } from '@dxos/broadcast';
import { Extension } from '@dxos/protocol';

/**
 * Peer chat.
 */
export class Messenger extends EventEmitter {
  static EXTENSION_NAME = 'dxos.protocol.messenger';

  // @type {Map<{string, Protocol>}
  _peers = new Map();

  /**
   * @constructor
   * @param {string} peerId
   * @param {Function} peerMessageHandler
   */
  constructor (peerId, peerMessageHandler = () => {}) {
    super();

    console.assert(Buffer.isBuffer(peerId));
    console.assert(peerMessageHandler);

    this._peerId = peerId;

    this._onMessage = (protocol, message) => {
      try {
        this.emit('message', message);
        peerMessageHandler(protocol, message);
      } catch (err) {
        // do nothing
      }
    };

    const middleware = {
      lookup: () => {
        return Array.from(this._peers.values()).map((peer) => {
          const { peerId } = peer.getSession();

          return {
            id: peerId,
            protocol: peer
          };
        });
      },
      send: (packet, peer) => {
        this._sendPeerMessage(peer.protocol, packet);
      },
      subscribe: (onPacket) => {
        this._peerMessageHandler = (protocol, chunk) => {
          const packet = onPacket(chunk.data);

          // Validate if is a broadcast message or not.
          const message = this._codec.decode(packet ? packet.data : chunk.data);

          this._onMessage(protocol, message);
        };
      }
    };

    this._broadcast = new Broadcast(middleware, {
      id: this._peerId
    });

    this._codec = new Codec('dxos.protocol.messenger.Message')
      .addJson(require('./schema.json'))
      .build();

    this._broadcast.run();
  }

  get peers () {
    return Array.from(this._peers.keys()).map(id => Buffer.from(id, 'hex'));
  }

  /**
   * Create protocol extension.
   * @return {Extension}
   */
  createExtension () {
    return new Extension(Messenger.EXTENSION_NAME)
      .setInitHandler((protocol) => {
        this._addPeer(protocol);
      })
      .setMessageHandler(this._peerMessageHandler)
      .setCloseHandler((protocol) => {
        this._removePeer(protocol);
      });
  }

  /**
   * Broadcast message to peers.
   * @param {string} type
   * @param {Buffer} payload
   * @return {Promise<void>}
   */
  async broadcastMessage (type, payload) {
    assert(type);
    assert(Buffer.isBuffer(payload));

    const buffer = this._codec.encode({ type, payload });
    await this._broadcast.publish(buffer);
  }

  /**
   * Send message to peer.
   * @param {Buffer} peerId
   * @param {string} type
   * @param {string} payload
   * @return {Promise<void>}
   */
  async sendMessage (peerId, type, payload) {
    assert(peerId);
    assert(type);
    assert(Buffer.isBuffer(payload));

    // Backward compatibility (peerId should always be a Buffer)
    if (typeof peerId === 'string') {
      peerId = Buffer.from(peerId, 'hex');
    }

    const peer = this._peers.get(peerId.toString('hex'));
    if (!peer) {
      this.emit('peer:not-found', peerId);
      return;
    }

    const buffer = this._codec.encode({ type, payload });
    await this._sendPeerMessage(peer, buffer);
  }

  /**
   * Send message to peer.
   * @param {Protocol} peer
   * @param {Buffer} buffer
   * @return {Promise<void>}
   * @private
   */
  async _sendPeerMessage (peer, buffer) {
    const chat = peer.getExtension(Messenger.EXTENSION_NAME);
    await chat.send(buffer, { oneway: true });
  }

  /**
   * Add peer.
   * @param {Protocol} protocol
   * @private
   */
  _addPeer (protocol) {
    const { peerId } = protocol.getSession();

    if (this._peers.has(peerId.toString('hex'))) {
      this.emit('peer:already-connected', peerId);
      return;
    }

    this._peers.set(peerId.toString('hex'), protocol);
    this.emit('peer:joined', peerId, protocol);
  }

  /**
   * Remove peer.
   * @param {Protocol} protocol
   * @private
   */
  _removePeer (protocol) {
    console.assert(protocol);
    const { peerId } = protocol.getSession();
    this._peers.delete(peerId.toString('hex'));
    this.emit('peer:left', peerId);
  }
}
