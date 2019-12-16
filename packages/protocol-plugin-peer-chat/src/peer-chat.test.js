//
// Copyright 2019 DxOS.
//

import crypto from 'crypto';

import generator from 'ngraph.generators';
import pump from 'pump';
import waitForExpect from 'wait-for-expect';

import { Protocol } from '@dxos/protocol';

import { PeerChat } from '.';

jest.setTimeout(30000);

const random = arr => arr[Math.floor(Math.random() * arr.length)];

const createNode = async (topic) => {
  const peerId = crypto.randomBytes(32);
  const messages = [];
  const chat = new PeerChat(peerId, (protocol, context, { message }) => {
    messages.push(message);
  });

  return {
    id: peerId,
    chat,
    messages,
    replicate (options) {
      return new Protocol(options)
        .setUserData({ peerId })
        .setExtensions([chat.createExtension()])
        .init(topic)
        .stream;
    }
  };
};

const createPeers = async (topic, graph) => {
  const peers = [];
  graph.forEachNode((node) => {
    peers.push(node);
  });

  return Promise.all(peers.map(async (node) => {
    node.data = await createNode(topic);
    return node.data;
  }));
};

const createConnections = (graph) => {
  const options = {
    streamOptions: {
      live: true
    }
  };

  let ic = graph.getLinksCount();

  return new Promise(resolve => {
    const connections = [];

    graph.forEachLink((link) => {
      const fromNode = graph.getNode(link.fromId).data;
      const toNode = graph.getNode(link.toId).data;
      const r1 = fromNode.replicate(options);
      const r2 = toNode.replicate(options);
      link.data = pump(r1, r2, r1);
      link.data.on('handshake', () => {
        ic--;
        connections.push(link.data);
        if (ic === 0) {
          resolve(connections);
        }
      });
    });
  });
};

describe('test peer chat in a network graph of 15 peers', () => {
  const topic = crypto.randomBytes(32);
  let graph, peers, connections;

  beforeAll(async () => {
    graph = generator.balancedBinTree(3);
    peers = await createPeers(topic, graph);
    connections = await createConnections(graph);
  });

  test('feed synchronization', async () => {
    const peer1 = random(peers);
    let peer2 = random(peer1.chat.peers);
    peer2 = peers.find(p => p.id.equals(peer2));

    peer1.chat.sendMessage(peer2.id, 'ping');

    await waitForExpect(() => {
      expect(peer2.messages).toEqual(['ping']);
    });

    peer2.messages.length = 0;

    await peer1.chat.broadcastMessage('ping');

    await waitForExpect(() => {
      peers.forEach(peer => {
        if (peer === peer1) {
          return;
        }
        expect(peer.messages).toEqual(['ping']);
      });
    }, 10000, 5000);

    peers.forEach(peer => peer.chat._broadcast.stop());
    connections.forEach(c => c.destroy());
  });
});
