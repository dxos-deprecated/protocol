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

    this._buildGraph();
    this._buildBroadcast();
  }

  get peerId () {
    return this._peerId;
  }

  get peers () {
    const list = [];
    this._graph.forEachNode((node) => {
      list.push(Buffer.from(node.id, 'hex'));
    });

    return list;
  }

  get graph () {
    return this._graph;
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
      queueMicrotask(() => this._pruneGraph());
    }, Math.floor(this._peerTimeout / 2));
  }

  stop () {
    this._broadcast.stop();
    clearInterval(this._scheduler);
    this._scheduler = null;
  }

  _buildGraph () {
    this._graph = createGraph();
    this._graph.addNode(this._peerId.toString('hex'));
    this._graph.on('changed', (changes) => {
      let graphUpdated = false;

      changes.forEach(({ changeType, node, link }) => {
        if (changeType === 'update') return;

        graphUpdated = true;

        const type = changeType === 'add' ? 'joined' : 'left';

        if (node) this.emit(`peer:${type}`, Buffer.from(node.id, 'hex'));
        if (link) this.emit(`connection:${type}`, Buffer.from(link.fromId, 'hex'), Buffer.from(link.toId, 'hex'));
      });

      if (graphUpdated) {
        log('graph-updated', changes);
        this.emit('graph-updated', changes, this._graph);
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
    this.on('remote-ping', packet => this._updateGraph(packet));
  }

  _peerMessageHandler (protocol, chunk) {
    this.emit('protocol-message', protocol, chunk);
  }

  _pruneGraph () {
    const now = Date.now();
    const localPeerId = this._peerId.toString('hex');
    this._graph.beginUpdate();
    this._graph.forEachNode((node) => {
      if (node.id === localPeerId) return;
      if (this._neighbors.has(node.id)) return;

      if ((now - node.data.lastUpdate) > this._peerTimeout) {
        this._deleteNode(node.id);
      }
    });
    this._graph.endUpdate();
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

    this._graph.beginUpdate();

    this._neighbors.set(peerIdHex, protocol);
    this._graph.addNode(peerIdHex, { lastUpdate: Date.now() });
    const [source, target] = [this._peerId.toString('hex'), peerIdHex].sort();
    if (!this._graph.hasLink(source, target)) {
      this._graph.addLink(source, target);
    }

    this._graph.endUpdate();

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

    // We clear the._graph graph.
    const localPeerId = this._peerId.toString('hex');
    this._graph.forEachNode((node) => {
      if (node.id === localPeerId) return;
      this._deleteNode(node.id);
    });
  }

  _updateGraph ({ peerId: from, connections = [] }) {
    const fromHex = from.toString('hex');

    const lastUpdate = Date.now();

    this._graph.beginUpdate();

    this._graph.addNode(fromHex, { lastUpdate });

    connections = connections.map(({ peerId }) => {
      peerId = peerId.toString('hex');
      this._graph.addNode(peerId, { lastUpdate });
      const [source, target] = [fromHex, peerId].sort();
      return { source, target };
    });

    connections.forEach((conn) => {
      if (!this._graph.hasLink(conn.source, conn.target)) {
        this._graph.addLink(conn.source, conn.target);
      }
    });

    this._graph.forEachLinkedNode(fromHex, (_, link) => {
      const toDelete = !connections.find(conn => conn.source === link.fromId && conn.target === link.toId);

      if (!toDelete) {
        return;
      }

      this._graph.removeLink(link);

      this._deleteNodeIfEmpty(link.fromId);
      this._deleteNodeIfEmpty(link.toId);
    });

    this._graph.endUpdate();
  }

  _deleteNode (id) {
    this._graph.removeNode(id);
    this._graph.forEachLinkedNode(id, (_, link) => {
      this._graph.removeLink(link);
    });
  }

  _deleteNodeIfEmpty (id) {
    const links = this._graph.getLinks(id) || [];
    if (links.length === 0) {
      this._graph.removeNode(id);
    }
  }
}
