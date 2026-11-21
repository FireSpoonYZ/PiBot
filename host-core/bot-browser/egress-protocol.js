import { isIP } from 'node:net';

export const EGRESS_CHUNK_BYTES = 32768;
export const EGRESS_MAX_STREAMS = 32;
export const EGRESS_TIMEOUT_MS = 30000;

export function readBrowserEgress(frame) {
  if (frame.type !== 'browser-egress') return null;
  const fail = () => { throw Object.assign(new Error('Invalid browser egress frame'), { code: 'INVALID_ARGUMENT' }); };
  const id = (value) => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
  if (!id(frame.id)) fail();
  const fields = ['type', 'op', 'id'];
  if (frame.op === 'open') {
    fields.push('targetDeviceId', 'fromDeviceId', 'botId', 'rendererId', 'host', 'port');
    if ((!id(frame.targetDeviceId) && !id(frame.fromDeviceId)) ||
        (frame.targetDeviceId !== undefined && frame.fromDeviceId !== undefined) ||
        !id(frame.botId) || !id(frame.rendererId)) fail();
    if (typeof frame.host !== 'string' || frame.host.length > 253 ||
        (!isIP(frame.host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(frame.host)) ||
        !Number.isInteger(frame.port) || frame.port < 1 || frame.port > 65535) fail();
  } else if (frame.op === 'data') {
    fields.push('data');
    if (typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data) ||
        !frame.data.length || frame.data.length > Math.ceil(EGRESS_CHUNK_BYTES / 3) * 4 ||
        Buffer.from(frame.data, 'base64').length > EGRESS_CHUNK_BYTES) fail();
  } else if (!['ready', 'ack', 'fin', 'close'].includes(frame.op)) fail();
  if (Object.keys(frame).some((key) => !fields.includes(key))) fail();
  return frame;
}
