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
        case 'valid': {
          this._remoteInit = true;
          this._remoteSignal.notify();
          return;
        }

        case 'invalid': {
          this._remoteInit = false;
          this._remoteSignal.notify();
          return;
        }

        case 'destroy': {
          process.nextTick(() => protocol.stream.destroy(new Error('invalid peer')));
        }
      }
    });

    this.setCloseHandler(() => {
      this._remoteInit = false;
      this._remoteSignal.notify(new Error('protocol closed'));
    });
  }

  async validate () {
    try {
      await this.send(Buffer.from('valid'));
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

  async invalidate () {
    try {
      if (this._remoteInit !== null) return;

      await this.send(Buffer.from('invalid'));
      this.send(Buffer.from('destroy'), { oneway: true });
    } catch (err) {}
  }
}
