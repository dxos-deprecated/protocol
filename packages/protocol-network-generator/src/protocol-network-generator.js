//
// Copyright 2019 DxOS.
//

import assert from 'assert';

import pump from 'pump';

import { NetworkGenerator, topologies } from '@dxos/network-generator';

const isStream = stream => typeof stream === 'object' && typeof stream.pipe === 'function';

export class ProtocolNetworkGenerator {
  constructor (createPeer) {
    assert(typeof createPeer === 'function', 'createPeer is required and must be a function');
    this._createPeer = (...args) => createPeer(...args);
    topologies.forEach(topology => {
      this[topology] = async (options) => this._generate(topology, options);
    });
  }

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
        const r1 = fromPeer.stream(protocol);
        const r2 = toPeer.stream(protocol);
        assert(isStream(r1), 'stream function must return a stream');
        assert(isStream(r2), 'stream function must return a stream');
        return pump(r1, r2, r1);
      }
    });

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
