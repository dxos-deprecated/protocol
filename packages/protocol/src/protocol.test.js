//
// Copyright 2019 DxOS.
//

import crypto from 'crypto';
import debug from 'debug';
import pump from 'pump';

import { Extension } from './extension';
import { Protocol } from './protocol';

const log = debug('test');
debug.enable('test,protocol');

jest.setTimeout(10 * 1000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('basic', async () => {
  expect.assertions(9);

  const bufferExtension = 'buffer';
  const timeout = 1000;

  const waitOneWayMessage = {};
  waitOneWayMessage.promise = new Promise((resolve) => {
    waitOneWayMessage.resolve = resolve;
  });

  const topic = crypto.randomBytes(32);
  const onInit = jest.fn();

  const protocol1 = new Protocol()
    .setSession({ user: 'user1' })
    .setExtension(
      new Extension(bufferExtension, { timeout })
        .setInitHandler(() => {
          onInit();
        })
    )
    .init(topic);

  const protocol2 = new Protocol()
    .setSession({ user: 'user2' })
    .setHandshakeHandler(() => {
      expect(onInit).toHaveBeenCalledTimes(2);
    })
    .setExtension(new Extension(bufferExtension, { timeout })
      .setInitHandler(async (protocol) => {
        await sleep(2 * 1000);
        onInit();
      })
      .setMessageHandler(async (protocol, message, options) => {
        const { data } = message;

        if (options.oneway) {
          waitOneWayMessage.resolve(data);
          return;
        }

        switch (data.toString()) {
          // Async response.
          case 'ping': {
            return Buffer.from('pong');
          }

          // Timeout.
          case 'timeout': {
            await sleep(timeout * 2);
            break;
          }

          // Error.
          default: {
            throw new Error('Invalid data.');
          }
        }
      }))
    .init(topic);

  protocol1.setHandshakeHandler(async (protocol) => {
    expect(onInit).toHaveBeenCalledTimes(2);

    const bufferMessages = protocol.getExtension(bufferExtension);

    bufferMessages.on('error', (err) => {
      log('Error: %o', err);
    });

    const session = protocol.getSession();

    expect(session.user).toBe('user2');

    {
      const { response: { data } } = await bufferMessages.send(Buffer.from('ping'));
      expect(data).toEqual(Buffer.from('pong'));
    }

    {
      const result = await bufferMessages.send(Buffer.from('oneway'), { oneway: true });
      expect(result).toBeUndefined();
      const data = await waitOneWayMessage.promise;
      expect(data).toEqual(Buffer.from('oneway'));
    }

    try {
      await bufferMessages.send(Buffer.from('crash'));
    } catch (err) {
      expect(err.code).toBe('ERR_SYSTEM');
      expect(err.message).toBe('Invalid data.');
    }

    try {
      await bufferMessages.send(Buffer.from('timeout'));
    } catch (err) {
      expect(err.code).toBe('ERR_REQUEST_TIMEOUT'); // timeout.
    }

    log('%o', bufferMessages.stats);
    protocol1.stream.destroy();
  });

  return new Promise(resolve => pump(protocol1.stream, protocol2.stream, protocol1.stream, () => {
    resolve();
  }));
});

test('protocol init error', async () => {
  expect.assertions(1);

  const bufferExtension = 'buffer';

  const waitOneWayMessage = {};
  waitOneWayMessage.promise = new Promise((resolve) => {
    waitOneWayMessage.resolve = resolve;
  });

  const topic = crypto.randomBytes(32);
  const onHandshake = jest.fn();

  const protocol = (name, error) => new Protocol()
    .setContext({ name })
    .setHandshakeHandler(() => {
      onHandshake();
    })
    .setExtension(
      new Extension(bufferExtension)
        .setInitHandler(async () => {
          if (error) {
            await sleep(5 * 100);
            throw error;
          }
        })
    )
    .init(topic);

  const protocol1 = protocol('protocol1');
  const protocol2 = protocol('protocol2', new Error('big error'));

  return new Promise(resolve => pump(protocol1.stream, protocol2.stream, protocol1.stream, () => {
    expect(onHandshake).not.toHaveBeenCalled();
    resolve();
  }));
});
