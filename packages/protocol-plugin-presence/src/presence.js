//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';
import createGraph from 'ngraph.graph';
import debug from 'debug';
import queueMicrotask from 'queue-microtask';

import { Extension } from '@dxos/protocol';
import { Broadcast } from '@dxos/broadcast';
import { Codec } from '@dxos/codec-protobuf';

import schema from './schema.json';

const log = debug('presence');

/**
 * Presence.
 */
export class Presence extends EventEmitter {
  static EXTENSION_NAME = 'dxos.protocol.presence';

  /**
   * @constructor
   * @param {string} peerId
   * @param {Object} options
   */
  constructor (peerId, options = {}) {
    super();

    console.assert(Buffer.isBuffer(peerId));

    const { peerTimeout = 2 * 60 * 1000 } = options;

    this._peerId = peerId;
    this._peerTimeout = peerTimeout;
    this._codec = new Codec('dxos.protocol.presence.Alive')
      .addJson(JSON.parse(schema))
      .build();
    this._neighbors = new Map();

    this._buildNetwork();
    this._buildBroadcast();
  }

  get peerId () {
    return this._peerId;
  }

  get peers () {
    const list = [];
    this.network.forEachNode((node) => {
      list.push(Buffer.from(node.id, 'hex'));
    });

    return list;
  }

  /**
   * Create protocol extension.
   * @return {Extension}
   */
  createExtension () {
    this.start();

    return new Extension(Presence.EXTENSION_NAME)
      .setMessageHandler(this._peerMessageHandler.bind(this))
      .setHandshakeHandler((protocol) => {
        log('handshake', protocol.getSession());
        this._addPeer(protocol);
      })
      .setCloseHandler((err, protocol) => {
        // This errors can happen all the time without been an issue.
        const protocolErrors = ['Remote timed out', 'premature close'];
        if (err && !protocolErrors.includes(err.message)) {
          console.warn(err.message);
        }
        log('close', protocol.getSession(), err && err.message);
        this._removePeer(protocol);
      });
  }

  async ping () {
    try {
      const message = {
        peerId: this._peerId,
        connections: Array.from(this._neighbors.values()).map((peer) => {
          const { peerId } = peer.getSession();
          return { peerId };
        })
      };
      await this._broadcast.publish(this._codec.encode(message));
      log('ping', message);
    } catch (err) {
      console.warn(err);
    }
  }

  start () {
    if (this._scheduler) {
      return;
    }

    this._broadcast.run();

    this._scheduler = setInterval(() => {
      this.ping();
      queueMicrotask(() => this._pruneNetwork());
    }, Math.floor(this._peerTimeout / 2));
  }

  stop () {
    this._broadcast.stop();
    clearInterval(this._scheduler);
    this._scheduler = null;
  }

  _buildNetwork () {
    this.network = createGraph();
    this.network.addNode(this._peerId.toString('hex'));
    this.network.on('changed', (changes) => {
      let networkUpdated = false;

      changes.forEach(({ changeType, node, link }) => {
        if (changeType === 'update') return;

        networkUpdated = true;

        const type = changeType === 'add' ? 'joined' : 'left';

        if (node) this.emit(`peer:${type}`, Buffer.from(node.id, 'hex'));
        if (link) this.emit(`connection:${type}`, Buffer.from(link.fromId, 'hex'), Buffer.from(link.toId, 'hex'));
      });

      if (networkUpdated) {
        log('network-updated', changes);
        this.emit('network-updated', changes, this.network);
      }
    });
  }

  _buildBroadcast () {
    const middleware = {
      lookup: () => {
        return Array.from(this._neighbors.values()).map((peer) => {
          const { peerId } = peer.getSession();

          return {
            id: peerId,
            protocol: peer
          };
        });
      },
      send: async (packet, { protocol }) => {
        const presence = protocol.getExtension(Presence.EXTENSION_NAME);
        await presence.send(packet, { oneway: true });
      },
      subscribe: (onPacket) => {
        this.on('protocol-message', (protocol, message) => {
          if (message && message.data) {
            onPacket(message.data);
          }
        });
      }
    };

    this._broadcast = new Broadcast(middleware, {
      id: this._peerId
    });

    this._broadcast.on('packet', packet => this.emit('remote-ping', this._codec.decode(packet.data)));
    this._broadcast.on('lookup-error', err => console.warn(err));
    this._broadcast.on('send-error', err => console.warn(err));
    this._broadcast.on('subscribe-error', err => console.warn(err));
    this.on('remote-ping', packet => this._updateNetwork(packet));
  }

  _peerMessageHandler (protocol, chunk) {
    this.emit('protocol-message', protocol, chunk);
  }

  _pruneNetwork () {
    const now = Date.now();
    const localPeerId = this._peerId.toString('hex');
    this.network.beginUpdate();
    this.network.forEachNode((node) => {
      if (node.id === localPeerId) return;
      if (this._neighbors.has(node.id)) return;

      if ((now - node.data.lastUpdate) > this._peerTimeout) {
        this._deleteNode(node.id);
      }
    });
    this.network.endUpdate();
  }

  /**
   * Add peer.
   * @param {Protocol} protocol
   * @private
   */
  _addPeer (protocol) {
    console.assert(protocol);
    const session = protocol.getSession();

    if (!session || !session.peerId) {
      this.emit('error', new Error('peerId not found'));
      return;
    }

    const { peerId } = session;
    const peerIdHex = peerId.toString('hex');

    if (this._neighbors.has(peerIdHex)) {
      this.emit('neighbor:already-connected', peerId);
      return;
    }

    this.network.beginUpdate();

    this._neighbors.set(peerIdHex, protocol);
    this.network.addNode(peerIdHex, { lastUpdate: Date.now() });
    const [source, target] = [this._peerId.toString('hex'), peerIdHex].sort();
    if (!this.network.hasLink(source, target)) {
      this.network.addLink(source, target);
    }

    this.network.endUpdate();

    this.emit('neighbor:joined', peerId, protocol);
    this.ping();
  }

  /**
   * Remove peer.
   * @param {Protocol} protocol
   * @private
   */
  _removePeer (protocol) {
    console.assert(protocol);
    const session = protocol.getSession();
    if (!session || !session.peerId) return;

    const { peerId } = session;
    const peerIdHex = peerId.toString('hex');

    this._neighbors.delete(peerIdHex);
    this._deleteNode(peerIdHex);
    this.emit('neighbor:left', peerId);

    if (this._neighbors.size > 0) {
      return this.ping();
    }

    // We clear the network graph.
    const localPeerId = this._peerId.toString('hex');
    this.network.forEachNode((node) => {
      if (node.id === localPeerId) return;
      this._deleteNode(node.id);
    });
  }

  _updateNetwork ({ peerId: from, connections = [] }) {
    const fromHex = from.toString('hex');

    const lastUpdate = Date.now();

    this.network.beginUpdate();

    this.network.addNode(fromHex, { lastUpdate });

    connections = connections.map(({ peerId }) => {
      peerId = peerId.toString('hex');
      this.network.addNode(peerId, { lastUpdate });
      const [source, target] = [fromHex, peerId].sort();
      return { source, target };
    });

    connections.forEach((conn) => {
      if (!this.network.hasLink(conn.source, conn.target)) {
        this.network.addLink(conn.source, conn.target);
      }
    });

    this.network.forEachLinkedNode(fromHex, (_, link) => {
      const toDelete = !connections.find(conn => conn.source === link.fromId && conn.target === link.toId);

      if (!toDelete) {
        return;
      }

      this.network.removeLink(link);

      this._deleteNodeIfEmpty(link.fromId);
      this._deleteNodeIfEmpty(link.toId);
    });

    this.network.endUpdate();
  }

  _deleteNode (id) {
    this.network.removeNode(id);
    this.network.forEachLinkedNode(id, (_, link) => {
      this.network.removeLink(link);
    });
  }

  _deleteNodeIfEmpty (id) {
    const links = this.network.getLinks(id) || [];
    if (links.length === 0) {
      this.network.removeNode(id);
    }
  }
}
