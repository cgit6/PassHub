import { EventEmitter } from 'node:events';
import { createG11bShutdownOwnerWithEngine, type G11bShutdownResources } from '../../src/deployment/internal/g11b-production-shutdown-engine.js';

function context(overrides: Partial<G11bShutdownResources> = {}) {
  const signals = new EventEmitter();
  const order: string[] = [];
  let deadline!: () => void;
  const handle = Object.freeze({ timer: true });
  const clear = jest.fn();
  const exit = jest.fn();
  const setExitCode = jest.fn();
  const resources = {
    beginShutdown: jest.fn(() => { order.push('GATE'); }),
    closeHttp: jest.fn(async () => { order.push('HTTP'); }),
    closeMongo: jest.fn(async () => { order.push('MONGO'); }),
    ...overrides,
  };
  const owner = createG11bShutdownOwnerWithEngine(resources, {
    onSignal: (signal, listener) => { signals.once(signal, listener); },
    armDeadline: (callback, milliseconds) => { expect(milliseconds).toBe(25_000); deadline = callback; return handle; },
    clearDeadline: clear, exit, setExitCode,
  });
  return { owner, signals, resources, order, clear, exit, setExitCode, handle, fireDeadline: () => deadline() };
}

describe('G11b production shutdown ownership', () => {
  test.each(['SIGTERM', 'SIGINT'])('%s closes the gate then HTTP then Mongo once and clears success deadline', async (signal) => {
    const ctx = context();
    ctx.signals.emit(signal);
    ctx.signals.emit(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
    await ctx.owner.close();
    expect(ctx.order).toEqual(['GATE', 'HTTP', 'MONGO']);
    expect(ctx.resources.closeHttp).toHaveBeenCalledTimes(1);
    expect(ctx.resources.closeMongo).toHaveBeenCalledTimes(1);
    expect(ctx.clear).toHaveBeenCalledWith(ctx.handle);
    expect(ctx.setExitCode).toHaveBeenCalledWith(0);
    ctx.fireDeadline();
    expect(ctx.exit).not.toHaveBeenCalled();
  });

  test('HTTP close failure still closes Mongo, reports failure and retains the forced-exit deadline', async () => {
    const ctx = context({ closeHttp: async () => { throw new Error('private close failure'); } });
    ctx.signals.emit('SIGTERM');
    await ctx.owner.close();
    expect(ctx.resources.closeMongo).toHaveBeenCalledTimes(1);
    expect(ctx.setExitCode).toHaveBeenCalledWith(1);
    expect(ctx.clear).not.toHaveBeenCalled();
    ctx.fireDeadline();
    ctx.fireDeadline();
    expect(ctx.exit).toHaveBeenCalledTimes(1);
    expect(ctx.exit).toHaveBeenCalledWith(1);
  });

  test('an unfinished HTTP close hits its deadline; late cleanup cannot turn failure into success', async () => {
    let release!: () => void;
    const ctx = context({ closeHttp: () => new Promise<void>((resolve) => { release = resolve; }) });
    ctx.signals.emit('SIGTERM');
    ctx.fireDeadline();
    expect(ctx.exit).toHaveBeenCalledWith(1);
    expect(ctx.resources.closeMongo).not.toHaveBeenCalled();
    release();
    await ctx.owner.close();
    expect(ctx.resources.closeMongo).toHaveBeenCalledTimes(1);
    expect(ctx.setExitCode).toHaveBeenCalledWith(1);
    expect(ctx.clear).not.toHaveBeenCalled();
  });

  test('signal emitted synchronously from HTTP cleanup cannot enter a second shutdown', async () => {
    const ctx = context();
    ctx.resources.closeHttp = jest.fn(async () => { ctx.signals.emit('SIGINT'); });
    ctx.signals.emit('SIGTERM');
    await ctx.owner.close();
    expect(ctx.resources.beginShutdown).toHaveBeenCalledTimes(1);
    expect(ctx.resources.closeHttp).toHaveBeenCalledTimes(1);
    expect(ctx.resources.closeMongo).toHaveBeenCalledTimes(1);
  });
});
