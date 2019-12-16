//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';

import { Broadcast } from '@dxos/broadcast';
import { Extension } from '@dxos/protocol';

import schema from './schema.json';

/**
 * Peer chat.
 */
export class PeerChat extends EventEmitter {
  static EXTENSION_NAME = 'dxos.protocol.peerchat';

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
          const { type, data: message } = chunk;

          const packet = onPacket(message);

          // Validate if is a broadcast message or not.
          if (packet) {
            this._onMessage(protocol, { type, message: packet.data.toString() });
          } else {
            this._onMessage(protocol, { type, message: message.toString() });
          }
        };
      }
    };

    this._broadcast = new Broadcast(middleware, {
      id: this._peerId
    });

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
    return new Extension(PeerChat.EXTENSION_NAME, { schema: JSON.parse(schema) })
      .setMessageHandler(this._peerMessageHandler)
      .setHandshakeHandler((protocol) => {
        this._addPeer(protocol);
      })
      .setCloseHandler((err, protocol) => {
        // This errors can happen all the time without been an issue.
        const protocolErrors = ['Remote timed out', 'premature close'];
        if (err && !protocolErrors.includes(err.message)) {
          console.warn(err.message);
        }
        this._removePeer(protocol);
      });
  }

  /**
   * Broadcast message to peers.
   * @param {string} message
   * @return {Promise<void>}
   */
  async broadcastMessage (message) {
    console.assert(message);

    await this._broadcast.publish(Buffer.from(message));
  }

  /**
   * Send message to peer.
   * @param {Buffer} peerId
   * @param {string} message
   * @return {Promise<void>}
   */
  async sendMessage (peerId, message) {
    console.assert(peerId);
    console.assert(message);

    // Backward compatibility (peerId should always be a Buffer)
    if (typeof peerId === 'string') {
      peerId = Buffer.from(peerId, 'hex');
    }

    const peer = this._peers.get(peerId.toString('hex'));
    if (!peer) {
      this.emit('peer:not-found', peerId);
      return;
    }

    await this._sendPeerMessage(peer, Buffer.from(message));
  }

  /**
   * Send message to peer.
   * @param {Protocol} peer
   * @param {Buffer} message
   * @return {Promise<void>}
   * @private
   */
  async _sendPeerMessage (peer, message) {
    const chat = peer.getExtension(PeerChat.EXTENSION_NAME);
    await chat.send({ __type_url: 'dxos.protocol.peerchat.Message', type: 'message', data: message }, { oneway: true });
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
