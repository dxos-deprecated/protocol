//
// Copyright 2020 DXOS.org
//

import assert from 'assert';

import { keyToString } from '@dxos/crypto';

export const COMMAND_SPAWN = 'dxos.protocol.bot.Spawn';
export const SPAWN_RESPONSE = 'dxos.protocol.bot.SpawnResponse';

export const COMMAND_STATUS = 'dxos.protocol.bot.GetStatus';
export const STATUS_RESPONSE = 'dxos.protocol.bot.Status';

export const COMMAND_INVITE = 'dxos.protocol.bot.Invite';
export const COMMAND_MANAGE = 'dxos.protocol.bot.Manage';
export const COMMAND_RESET = 'dxos.protocol.bot.Reset';
export const COMMAND_STOP = 'dxos.protocol.bot.Stop';
export const COMMAND_RESPONSE = 'dxos.protocol.bot.CommandResponse';

/**
 * Creates a new spawn command message.
 * @param {string} botName
 */
export const createSpawnCommand = (botName, options) => {
  return {
    message: {
      __type_url: COMMAND_SPAWN,
      botName,
      options
    }
  };
};

/**
 * Creates a new bot management command message.
 * @param {string} botId
 * @param {string} command
 */
export const createBotManagementCommand = (botId, command) => {
  assert(botId);
  assert(command);

  return {
    message: {
      __type_url: COMMAND_MANAGE,
      botId,
      command
    }
  };
};

/**
 * Creates reset command.
 */
export const createResetCommand = (source) => {
  return {
    message: {
      __type_url: COMMAND_RESET,
      source
    }
  };
};

/**
 * Creates stop command.
 */
export const createStopCommand = (errorCode) => {
  return {
    message: {
      __type_url: COMMAND_STOP,
      errorCode
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
 * @param {String} botId
 */
export const createSpawnResponse = (botId) => {
  return {
    message: {
      __type_url: SPAWN_RESPONSE,
      botId
    }
  };
};

/**
 * Creates a new invitation command message.
 * @param {string} botId
 * @param {Buffer} topic
 * @param {string} modelOptions
 * @param {string} invitation
 */
export const createInvitationCommand = (botId, topic, modelOptions, invitation) => {
  assert(botId);
  assert(topic);
  assert(modelOptions);
  assert(Buffer.isBuffer(topic));

  return {
    message: {
      __type_url: COMMAND_INVITE,
      botId,
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
