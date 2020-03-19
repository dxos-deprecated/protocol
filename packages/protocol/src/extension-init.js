//
// Copyright 2020 DxOS.
//

import Signal from 'signal-promise';

import { Extension } from './extension';

export class ExtensionInit extends Extension {
  constructor (options = {}) {
    super('dxos.protocol.init', options);

    this._timeout = options.timeout;
    this._remoteInit = null;
    this._remoteSignal = new Signal();

    this.setMessageHandler((protocol, message) => {
      const { data } = message;

      if (data.toString() === 'continue') {
        this._remoteInit = true;
        this._remoteSignal.notify();
        return;
      }

      // break
      this._remoteInit = false;
      this._remoteSignal.notify();
    });

    this.setCloseHandler(() => {
      this._remoteInit = false;
      this._remoteSignal.notify();
    });
  }

  async continue () {
    try {
      await this.send(Buffer.from('continue'));
      if (this._remoteInit !== null) {
        return this._remoteInit;
      } else {
        await this._remoteSignal.wait(this._timeout);
        return this._remoteInit;
      }
    } catch (err) {
      return false;
    }
  }

  async break () {
    try {
      if (this._remoteInit === false) return;

      await this.send(Buffer.from('break'));
    } catch (err) {}
  }
}
