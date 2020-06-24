//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import { EventEmitter } from 'events';

import pump from 'pump';
import pEvent from 'p-event';

import { NetworkGenerator, topologies } from '@dxos/network-generator';

/**
 * @typedef {Object} Peer
 * @property {Buffer} id Required peer id.
 */

/**
 *
 * @callback CreatePeerCallback
 * @param {Buffer} topic Buffer to initialize the stream protocol
 * @param {Buffer} id Random buffer of 32 bytes to represent the id of the peer
 * @returns {Promise<Peer>}
 */

const kInitiator = Symbol('initiator');

const isProtocol = protocol => typeof protocol === 'object' && protocol.toString().includes('Protocol');

export class ProtocolNetworkGenerator extends EventEmitter {
  /**
   * @constructor
   *
   * @param {CreatePeerCallback} createPeer
   */
  constructor (createPeer) {
    super();

    assert(typeof createPeer === 'function', 'createPeer is required and must be a function');
    this._createPeer = (...args) => createPeer(...args);
    topologies.forEach(topology => {
      this[topology] = async (options) => this._generate(topology, options);
    });
  }

  /**
   * Generate a network based on a ngraph.generator topology
   *
   * @param {string} topology Valid ngraph.generator topology
   * @param {Object} options
   * @param {Buffer} options.topic Buffer to use on the stream protocol initialization
   * @param {boolean} [options.waitForFullConnection=true] Wait until all the connections are ready
   * @param {Object} options.peer peer options
   * @param {Object} options.protocol Protocol options
   * @param {Array} options.parameters Arguments for the ngraph generator.
   * @returns {Promise<Network>}
   */
  async _generate (topology, options = {}) {
    const { topic, waitForFullConnection = true, peer: peerOptions = {}, protocol = {}, parameters = [] } = options;

    assert(Buffer.isBuffer(topic), 'topic is required and must be a buffer');

    const generator = new NetworkGenerator({
      createPeer: async id => {
        const peer = await this._createPeer(topic, id, peerOptions);
        assert(typeof peer === 'object', 'peer must be an object');
        assert(Buffer.isBuffer(peer.id), 'peer.id is required');
        assert(typeof peer.createProtocol === 'function', 'peer.createProtocol is required and must be a function');
        return peer;
      },
      createConnection: (fromPeer, toPeer) => {
        const p1 = fromPeer.createProtocol({ topic, options: protocol });
        // Target peer shouldn't get the topic, this help us to simulate the network like discovery-swarm/hyperswarm
        const p2 = toPeer.createProtocol({ options: protocol });
        assert(isProtocol(p1), 'protocol function must return a protocol instance');
        assert(isProtocol(p2), 'protocol function must return a protocol instance');

        const stream = pump(p1.stream, p2.stream, p1.stream);

        stream[kInitiator] = p1;

        return stream;
      }
    });

    generator.on('error', err => this.emit('error', err));

    const network = await generator[topology](...parameters);

    if (waitForFullConnection) {
      await Promise.all(network.connections.map(conn => {
        if (conn.stream.destroyed) throw new Error('connection destroyed');
        if (conn.stream[kInitiator].connected) return;

        return pEvent(conn.stream[kInitiator], 'handshake');
      }));
    }

    return network;
  }
}
