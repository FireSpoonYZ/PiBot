import { Duplex } from 'node:stream';
import { EGRESS_CHUNK_BYTES, EGRESS_TIMEOUT_MS } from './egress-protocol.js';

// One acknowledged chunk per direction bounds every stream, including a slow
// native browser. Acknowledgement follows consumption, never mere receipt.
export class BrowserEgressChannel extends Duplex {
  constructor(id, send, onClose) {
    super({ highWaterMark: EGRESS_CHUNK_BYTES });
    this.id = id;
    this.send = send;
    this.onClose = onClose;
    this.pendingWrite = null;
    this.pendingRead = false;
    this.ready = false;
    this.armTimeout();
  }
  armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.destroy(new Error('Browser egress timed out')), EGRESS_TIMEOUT_MS);
    this.timer.unref?.();
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout(milliseconds, callback) {
    if (callback) this.once('timeout', callback);
    // The tunnel owns a bounded idle deadline even when HTTP requests disable
    // the normal socket timeout (setTimeout(0)).
    this.armTimeout();
    return this;
  }
  frame(op, extra = {}) {
    const result = this.send({ type: 'browser-egress', op, id: this.id, ...extra });
    if (result === false || result?.ok === false) this.destroy(new Error('Browser egress disconnected'));
  }
  _read() {
    if (this.pendingRead) {
      this.pendingRead = false;
      this.frame('ack');
    }
  }
  _write(data, _encoding, callback) {
    if (data.length === 0) { callback(); return; }
    this.pendingWrite = { data, offset: 0, callback, awaiting: false };
    this.flushChunk();
  }
  flushChunk() {
    const pending = this.pendingWrite;
    if (!this.ready || !pending || pending.awaiting || this.destroyed) return;
    const chunk = pending.data.subarray(pending.offset, pending.offset + EGRESS_CHUNK_BYTES);
    pending.offset += chunk.length;
    pending.awaiting = true;
    this.frame('data', { data: chunk.toString('base64') });
  }
  accept(frame) {
    this.armTimeout();
    if (frame.op === 'ready' && !this.ready) {
      this.ready = true;
      this.emit('connect');
      this.flushChunk();
    } else if (frame.op === 'data' && this.ready && !this.remoteEnded && !this.pendingRead) {
      this.pendingRead = true;
      if (this.push(Buffer.from(frame.data, 'base64'))) this._read();
    } else if (frame.op === 'ack' && this.pendingWrite?.awaiting) {
      const pending = this.pendingWrite;
      pending.awaiting = false;
      if (pending.offset === pending.data.length) {
        this.pendingWrite = null;
        pending.callback();
      } else this.flushChunk();
    } else if (frame.op === 'fin' && this.ready && !this.remoteEnded && !this.pendingRead) {
      this.remoteEnded = true;
      this.push(null);
    } else if (frame.op === 'close') {
      this.remoteClosed = true;
      this.destroy();
    } else this.destroy(new Error('Invalid browser egress sequence'));
  }
  _final(callback) { this.frame('fin'); callback(); }
  _destroy(error, callback) {
    clearTimeout(this.timer);
    if (!this.remoteClosed) this.frame('close');
    const pending = this.pendingWrite;
    this.pendingWrite = null;
    pending?.callback(error || new Error('Browser egress closed'));
    this.onClose?.();
    callback(error);
  }
}
