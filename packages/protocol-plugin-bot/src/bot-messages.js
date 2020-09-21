//
// Copyright 2020 DXOS.org
//

import assert from 'assert';

export const COMMAND_SIGN = 'dxos.protocol.bot.SignChallenge';
export const SIGN_RESPONSE = 'dxos.protocol.bot.SignChallengeResponse';
export const COMMAND_BOT_INVITE = 'dxos.protocol.bot.InvitationMessage';
export const BOT_COMMAND = 'dxos.protocol.bot.BotCommand';
export const BOT_COMMAND_RESPONSE = 'dxos.protocol.bot.BotCommandResponse';
export const BOT_EVENT = 'dxos.protocol.bot.BotEvent';

export const MESSAGE_CONFIRM = 'dxos.protocol.bot.ConfirmConnection';

/**
 * Creates a new Sign command message.
 * @param {Buffer} message
 */
export const createSignCommand = (message) => {
  assert(message);
  assert(Buffer.isBuffer(message));

  return {
    message: {
      __type_url: COMMAND_SIGN,
      message
    }
  };
};

/**
 * Creates a response for Sign command message.
 * @param {Buffer} signature
 */
export const createSignResponse = (signature) => {
  assert(signature);
  assert(Buffer.isBuffer(signature));

  return {
    message: {
      __type_url: SIGN_RESPONSE,
      signature
    }
  };
};

/**
 * Creates a new connection confirmation message.
 * @param {string} id
 */
export const createConnectConfirmMessage = (botId) => {
  assert(botId);

  return {
    message: {
      __type_url: MESSAGE_CONFIRM,
      botId
    }
  };
};

/**
 * Creates a new invitation message.
 * @param {string} topic
 * @param {Object} invitation
 */
export const createInvitationMessage = (topic, invitation) => {
  assert(topic);
  assert(invitation);

  return {
    message: {
      __type_url: COMMAND_BOT_INVITE,
      topic,
      invitation
    }
  };
};

/**
 * Create arbitrary message to bot.
 * @param {string} botId
 * @param {Buffer} command
 */
export const createBotCommand = (botId, command) => {
  assert(botId);
  assert(command);

  return {
    message: {
      __type_url: BOT_COMMAND,
      botId,
      command
    }
  };
};

/**
 * Create arbitrary message response from bot.
 * @param {Buffer} data
 * @param {string} error
 */
export const createBotCommandResponse = (data, error) => {
  return {
    message: {
      __type_url: BOT_COMMAND_RESPONSE,
      data,
      error
    }
  };
};

/**
 * Create Bot event.
 * @param {string} botId
 * @param {string} type
 * @param {Buffer} data
 */
export const createEvent = (botId, type, data) => {
  assert(botId);
  assert(type);

  return {
    message: {
      __type_url: BOT_EVENT,
      botId,
      type,
      data
    }
  };
};
