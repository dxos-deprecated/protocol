//
// Copyright 2019 DxOS.
//

import crypto from 'hypercore-crypto';
import debug from 'debug';
import pump from 'pump';

import { Extension } from './extension';
import { Protocol } from './protocol';

const log = debug('test');
debug.enable('test,protocol');

jest.setTimeout(10 * 1000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('protocol', async () => {
  const extension = 'keys';
  const timeout = 1000;

  const waitOneWayMessage = {};
  waitOneWayMessage.promise = new Promise((resolve) => {
    waitOneWayMessage.resolve = resolve;
  });

  const { publicKey } = crypto.keyPair();

  const protocol1 = new Protocol()
    .setUserData({ user: 'user1' })
    .setExtension(new Extension(extension, { timeout }))
    .init(publicKey);

  const protocol2 = new Protocol()
    .setUserData({ user: 'user2' })
    .setExtension(new Extension(extension, { timeout })
      .setMessageHandler(async (protocol, context, { type, topics }) => {
        // Check credentials.
        if (context.user !== 'user1') {
          throw new Error('Not authorized');
        }

        const feedStore = {
          foo: ['f1', 'f2', 'f3'],
          bar: ['f3', 'f4']
        };

        switch (type) {
          case 'list': {
            return {
              topics: Object.keys(feedStore)
            };
          }

          // Async response.
          case 'request': {
            const results = topics.map((topic) => {
              const keys = feedStore[topic] || [];
              return { topic, keys };
            });

            return new Promise((resolve) => {
              setTimeout(() => {
                resolve({ topics: results });
              }, 0);
            });
          }

          case 'oneway': {
            waitOneWayMessage.resolve({ topics });
            break;
          }

          // Timeout.
          case 'timeout': {
            await sleep(timeout * 2);
            break;
          }

          // Error.
          default: {
            throw new Error(`Invalid type: ${type}`);
          }
        }
      }))
    .init(publicKey);

  protocol1.on('handshake', async (protocol) => {
    const keys = protocol.getExtension(extension);

    keys.on('error', (err) => {
      log('Error: %o', err);
    });

    {
      const { context, response: { topics } } = await keys.send({ type: 'list' });
      expect(context.user).toBe('user2');
      expect(topics).toHaveLength(2);
      log('%o', topics);
    }

    {
      const { context, response: { topics } } = await keys.send({ type: 'request', topics: ['foo', 'bar'] });
      expect(context.user).toBe('user2');
      expect(topics.find(r => r.topic === 'foo').keys).toHaveLength(3);
      expect(topics.find(r => r.topic === 'bar').keys).toHaveLength(2);
      log('%o', topics);
    }

    {
      const { context, response: { topics } } = await keys.send({ type: 'request', topics: ['zoo'] });
      expect(context.user).toBe('user2');
      expect(topics.find(r => r.topic === 'zoo').keys).toHaveLength(0);
      log('%o', topics);
    }

    {
      const result = await keys.send({ type: 'oneway', topics: ['zoo'] }, { oneway: true });
      expect(result).toBeUndefined();
      const { topics } = await waitOneWayMessage.promise;
      expect(topics[0]).toBe('zoo');
      log('%o', topics);
    }

    try {
      await keys.send({ type: 'xxx' });
    } catch (ex) {
      expect(ex.code).toBe(500); // exception.
      log('%o', ex);
    }

    try {
      await keys.send({ type: 'timeout' });
    } catch (ex) {
      expect(ex.code).toBe(408); // timeout.
      log('%o', ex);
    }

    log('%o', keys.stats);
    protocol1.stream.destroy();
  });

  return new Promise(resolve => pump(protocol1.stream, protocol2.stream, protocol1.stream, () => {
    resolve();
  }));
});
