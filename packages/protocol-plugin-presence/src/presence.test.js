//
// Copyright 2019 DxOS.
//

import crypto from 'hypercore-crypto';
import waitForExpect from 'wait-for-expect';
import debug from 'debug';
import path from 'ngraph.path';
import pump from 'pump';

import { Protocol } from '@dxos/protocol';

import { Presence } from './presence';

const log = debug('test');
debug.enable('test');

const TIMEOUT = 16 * 1000;

jest.setTimeout(TIMEOUT);

const createPeer = (publicKey) => {
  const peerId = crypto.randomBytes(6);

  const presence = new Presence(peerId);
  const stream = () => new Protocol({
    streamOptions: {
      live: true
    }
  })
    .setUserData({ peerId })
    .setExtension(presence.createExtension())
    .init(publicKey)
    .stream;

  return { id: peerId, presence, stream };
};

const connect = (source, target) => {
  return pump(source.stream(), target.stream(), source.stream());
};

test('presence', async () => {
  const waitOneWayMessage = {};
  waitOneWayMessage.promise = new Promise((resolve) => {
    waitOneWayMessage.resolve = resolve;
  });

  const { publicKey } = crypto.keyPair();

  const peer1 = createPeer(publicKey);
  const peer2 = createPeer(publicKey);
  const peer3 = createPeer(publicKey);
  const peer4 = createPeer(publicKey);

  peer1.presence.on('peer:joined', (peerId) => {
    log(`peer:joined ${peerId.toString('hex')}`);
  });

  peer1.presence.on('peer:left', (peerId) => {
    log(`peer:left ${peerId.toString('hex')}`);
  });

  const connections = [
    connect(peer1, peer2),
    connect(peer2, peer3),
    connect(peer3, peer4)
  ];

  await waitForExpect(() => {
    const pathFinder = path.aStar(peer1.presence.network);
    const fromId = peer1.id.toString('hex');
    expect(pathFinder.find(fromId, peer2.id.toString('hex')).length).toBeGreaterThan(0);
    expect(pathFinder.find(fromId, peer3.id.toString('hex')).length).toBeGreaterThan(0);
    expect(pathFinder.find(fromId, peer4.id.toString('hex')).length).toBeGreaterThan(0);
  }, TIMEOUT, 2 * 1000);

  log('network full connected');

  connections.forEach(con => con.destroy());

  await waitForExpect(() => {
    expect(peer1.presence.network.getNodesCount()).toBe(1);
  }, TIMEOUT, 2 * 1000);

  peer1.presence.stop();
  peer2.presence.stop();
  peer3.presence.stop();
  peer4.presence.stop();
});
