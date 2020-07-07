//
// Copyright 2020 DxOS.
//

import { EventEmitter } from 'events';
import assert from 'assert';

import { Codec } from '@dxos/codec-protobuf';
import { Broadcast } from '@dxos/broadcast';
import { Extension } from '@dxos/protocol';
import { keyToString, keyToBuffer } from '@dxos/crypto';

export const COMMAND_SPAWN = 'dxos.protocol.bot.Spawn';
export const SPAWN_RESPONSE = 'dxos.protocol.bot.SpawnResponse';

export const COMMAND_STATUS = 'dxos.protocol.bot.GetStatus';
export const STATUS_RESPONSE = 'dxos.protocol.bot.Status';

export const COMMAND_INVITE = 'dxos.protocol.bot.Invite';
export const COMMAND_MANAGE = 'dxos.protocol.bot.Manage';
export const COMMAND_RESET = 'dxos.protocol.bot.Reset';
export const COMMAND_RESPONSE = 'dxos.protocol.bot.CommandResponse';

const DEFAULT_TIMEOUT = 60000;

/**
 * Bot protocol codec.
 */
export const codec = new Codec('dxos.protocol.bot.Message')
  // eslint-disable-next-line global-require
  .addJson(require('./schema.json'))
  .build();

/**
 * Creates a new spawn command message.
 * @param {string} botId
 */
export const createSpawnCommand = (botId) => {
  assert(botId);

  return {
    message: {
      __type_url: COMMAND_SPAWN,
      botId
    }
  };
};

/**
 * Creates a new bot management command message.
 * @param {string} botUID
 * @param {string} command
 */
export const createBotManagementCommand = (botUID, command) => {
  assert(botUID);
  assert(command);

  return {
    message: {
      __type_url: COMMAND_MANAGE,
      botUID,
      command
    }
  };
};

/**
 * Creates reset command.
 */
export const createResetCommand = () => {
  return {
    message: {
      __type_url: COMMAND_RESET
    }
  };
};

/**
 * Creates status command message.
 */
export const createStatusCommand = () => {
  return {
    message: {
      __type_url: COMMAND_STATUS
    }
  };
};

/**
 * Creates status response message.
 * @param {String} version
 * @param {String} uptime
 * @param {Array} bots
 */
export const createStatusResponse = (version, platform, uptime, bots) => {
  return {
    message: {
      __type_url: STATUS_RESPONSE,
      version,
      platform,
      uptime,
      bots
    }
  };
};

/**
 * Creates spawn response message.
 * @param {String} botUID
 */
export const createSpawnResponse = (botUID) => {
  return {
    message: {
      __type_url: SPAWN_RESPONSE,
      botUID
    }
  };
};

/**
 * Creates a new invitation command message.
 * @param {string} botUID
 * @param {Buffer} topic
 * @param {string} modelOptions
 * @param {string} invitation
 */
export const createInvitationCommand = (botUID, topic, modelOptions, invitation) => {
  assert(botUID);
  assert(topic);
  assert(modelOptions);
  assert(Buffer.isBuffer(topic));

  return {
    message: {
      __type_url: COMMAND_INVITE,
      botUID,
      topic: keyToString(topic),
      modelOptions,
      invitation
    }
  };
};

/**
 * Creates arbitrary response message.
 * @param {boolean} status
 * @param {String} error
 */
export const createCommandResponse = (status, error) => {
  return {
    message: {
      __type_url: COMMAND_RESPONSE,
      status,
      error
    }
  };
};

/**
 * Bot protocol.
 */
export class BotPlugin extends EventEmitter {
  static EXTENSION_NAME = 'dxos.protocol.bot';

  // @type {Map<{string, Protocol>}
  _peers = new Map();

  /**
   * @constructor
   * @param {string} peerId
   * @param {Function} commandHandler
   */
  constructor (peerId, commandHandler = () => {}) {
    super();

    assert(Buffer.isBuffer(peerId));
    assert(commandHandler);

    this._peerId = peerId;

    this._onMessage = async (protocol, message) => {
      try {
        this.emit('message', message);
        const response = await commandHandler(protocol, message);
        if (response) {
          return codec.encode(response);
        }
      } catch (err) {
        // Ignore with console error.
        console.error(err);
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
      send: async (packet, peer) => {
        await peer.protocol.getExtension(BotPlugin.EXTENSION_NAME).send(packet);
      },
      subscribe: (onPacket) => {
        this._commandHandler = (protocol, chunk) => {
          const packet = onPacket(chunk.data);

          // Validate if is a broadcast message or not.
          const message = this._codec.decode(packet ? packet.data : chunk.data);

          return this._onMessage(protocol, message);
        };
      }
    };

    this._broadcast = new Broadcast(middleware, {
      id: this._peerId
    });

    this._codec = codec;
  }

  get peers () {
    return Array.from(this._peers.keys()).map(id => keyToBuffer(id));
  }

  /**
   * Create protocol extension.
   * @return {Extension}
   */
  createExtension (timeout = DEFAULT_TIMEOUT) {
    this._broadcast.run();

    return new Extension(BotPlugin.EXTENSION_NAME, { timeout })
      .setInitHandler((protocol) => {
        this._addPeer(protocol);
      })
      .setHandshakeHandler(protocol => {
        const { peerId } = protocol.getSession();

        if (this._peers.has(keyToString(peerId))) {
          this.emit('peer:joined', peerId, protocol);
        }
      })
      .setMessageHandler(this._commandHandler)
      .setCloseHandler((protocol) => {
        this._removePeer(protocol);
      });
  }

  /**
   * Broadcast command to peers.
   * @param {object} command
   * @return {Promise<void>}
   */
  async broadcastCommand (command) {
    assert(command);

    const buffer = this._codec.encode(command);
    await this._broadcast.publish(buffer);
  }

  /**
   * Send command to peer.
   * @param {Buffer} peerId
   * @param {object} command
   * @return {Promise<object>}
   */
  async sendCommand (peerId, command) {
    assert(peerId);
    assert(command);
    assert(Buffer.isBuffer(peerId));

    const peer = this._peers.get(keyToString(peerId));
    if (!peer) {
      this.emit('peer:not-found', peerId);
      return;
    }

    const buffer = this._codec.encode(command);
    const result = await peer.getExtension(BotPlugin.EXTENSION_NAME).send(buffer, { oneway: false });

    let response;
    if (result.response && Buffer.isBuffer(result.response.data)) {
      response = codec.decode(result.response.data);
    }

    return response;
  }

  /**
   * Add peer.
   * @param {Protocol} protocol
   * @private
   */
  _addPeer (protocol) {
    const { peerId } = protocol.getSession();

    if (this._peers.has(keyToString(peerId))) {
      return;
    }

    this._peers.set(keyToString(peerId), protocol);
  }

  /**
   * Remove peer.
   * @param {Protocol} protocol
   * @private
   */
  _removePeer (protocol) {
    console.assert(protocol);

    const { peerId } = protocol.getSession();
    this._peers.delete(keyToString(peerId));
    this.emit('peer:exited', peerId);
  }
}
