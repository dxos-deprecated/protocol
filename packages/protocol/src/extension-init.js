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

      switch (data.toString()) {
        case 'continue': {
          this._remoteInit = true;
          this._remoteSignal.notify();
          return;
        }

        case 'break': {
          this._remoteInit = false;
          this._remoteSignal.notify();
          return;
        }

        case 'destroy': {
          process.nextTick(() => protocol.stream.destroy(new Error('protocol closed')));
        }
      }
    });

    this.setCloseHandler(() => {
      this._remoteInit = false;
      this._remoteSignal.notify(new Error('protocol closed'));
    });
  }

  async continue () {
    try {
      await this.send(Buffer.from('continue'));
      if (this._remoteInit !== null) {
        return this._remoteInit;
      } else {
        await this._remoteSignal.wait();
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
      this.send(Buffer.from('destroy'), { oneway: true });
    } catch (err) {}
  }
}
