//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import { EventEmitter } from 'events';

import pump from 'pump';

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

const isStream = stream => typeof stream === 'object' && typeof stream.pipe === 'function';

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
   * @param {Object} options.protocol Protocol options
   * @param {Array} options.parameters Arguments for the ngraph generator.
   * @returns {Promise<Network>}
   */
  async _generate (topology, options = {}) {
    const { topic, waitForFullConnection = true, protocol = {}, parameters = [] } = options;

    assert(Buffer.isBuffer(topic), 'topic is required and must be a buffer');

    const generator = new NetworkGenerator({
      createPeer: async id => {
        const peer = await this._createPeer(topic, id);
        assert(typeof peer === 'object', 'peer must be an object');
        assert(Buffer.isBuffer(peer.id), 'peer.id is required');
        assert(typeof peer.stream === 'function', 'peer.stream is required and must be a function');
        return peer;
      },
      createConnection: (fromPeer, toPeer) => {
        const r1 = fromPeer.stream({ topic, options: protocol });
        // Target peer shouldn't get the topic, this help us to simulate the network like discovery-swarm/hyperswarm
        const r2 = toPeer.stream({ options: protocol });
        assert(isStream(r1), 'stream function must return a stream');
        assert(isStream(r2), 'stream function must return a stream');
        return pump(r1, r2, r1);
      }
    });

    generator.on('error', err => this.emit('error', err));

    const network = await generator[topology](...parameters);

    if (waitForFullConnection) {
      await Promise.all(
        network.connections.map(
          conn => new Promise(resolve => conn.stream.once('handshake', () => resolve()))
        )
      );
    }

    return network;
  }
}
