import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentState, LOCK_STALE_MS, type EventInput } from './state'

function openState(overrides: { connectionId?: string; origin?: string; userId?: string; stateDir?: string } = {}): AgentState {
  return AgentState.open({
    stateDir: overrides.stateDir ?? mkdtempSync(join(tmpdir(), 'agent-state-')),
    connectionId: overrides.connectionId ?? 'ocai',
    origin: overrides.origin ?? 'https://mm.example',
    userId: overrides.userId ?? 'bot-1',
  })
}

function event(id: string, overrides: Partial<EventInput> = {}): EventInput {
  return {
    event_id: id,
    connection: 'ocai',
    post_id: id,
    channel_id: 'chan',
    root_id: '',
    sender_id: 'peer',
    sender_username: 'peer-name',
    text: 'hi',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

describe('checkpoints and events', () => {
  test('re-sweeping the same window stores nothing new and leaves the event unsettled', () => {
    const state = openState()
    expect(state.commitSweep({ channelId: 'chan', events: [event('e1')], checkpoint: 1000 })).toBe(1)
    expect(state.commitSweep({ channelId: 'chan', events: [event('e1')], checkpoint: 1000 })).toBe(0)
    expect(state.pending()).toHaveLength(1)
    expect(state.checkpoint('chan')).toBe(1000)
  })

  test('a failed sweep leaves the checkpoint where it was', () => {
    const state = openState()
    state.commitSweep({ channelId: 'chan', events: [event('e1')], checkpoint: 1000 })
    const poisoned = { ...event('e2'), text: undefined } as unknown as EventInput
    expect(() => state.commitSweep({ channelId: 'chan', events: [event('e2'), poisoned], checkpoint: 5000 })).toThrow()
    expect(state.checkpoint('chan')).toBe(1000)
    expect(state.event('e2')).toBeUndefined()
  })

  test('an overflowed window is recorded as a gap, not swallowed', () => {
    const state = openState()
    state.commitSweep({
      channelId: 'chan',
      events: [event('e1')],
      checkpoint: 9000,
      gap: { channel_id: 'chan', from_ms: 1000, to_ms: 4000, observed: 1000 },
    })
    expect(state.gaps()).toHaveLength(1)
    expect(state.gaps()[0]).toMatchObject({ channel_id: 'chan', from_ms: 1000, to_ms: 4000 })
  })

  test('ack settles exactly one event', () => {
    const state = openState()
    state.commitSweep({ channelId: 'chan', events: [event('e1'), event('e2')], checkpoint: 1000 })
    state.ack('e1')
    expect(state.pending().map((e) => e.event_id)).toEqual(['e2'])
  })

  test('state is scoped by identity: another bot on the same stateDir sees nothing', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-state-'))
    const first = openState({ stateDir })
    first.commitSweep({ channelId: 'chan', events: [event('e1')], checkpoint: 1000 })
    const other = openState({ stateDir, userId: 'bot-2' })
    expect(other.pending()).toHaveLength(0)
    expect(other.checkpoint('chan')).toBeUndefined()
  })
})

describe('watcher lock', () => {
  test('a live holder blocks a second watcher, a dead one does not', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-state-'))
    const first = openState({ stateDir })
    expect(first.acquireLock().ok).toBe(true)

    const second = openState({ stateDir })
    const blocked = second.acquireLock()
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.holder.pid).toBe(process.pid)

    // Same scope, but the holder's heartbeat has stopped: the lock is takeable.
    const later = Date.now() + LOCK_STALE_MS + 1000
    expect(second.acquireLock(later).ok).toBe(true)
  })
})

describe('outbound claim', () => {
  test('only the first claimer may post; the loser sees the recorded attempt', () => {
    const state = openState()
    state.commitSweep({ channelId: 'chan', events: [event('e1')], checkpoint: 1000 })
    expect(state.claimOutbound('e1', 'answer').claimed).toBe(true)
    const second = state.claimOutbound('e1', 'answer')
    expect(second.claimed).toBe(false)
    expect(second.existing).toMatchObject({ status: 'unknown', message: 'answer' })
  })

  test('a definitively rejected attempt can be retaken, an ambiguous one cannot', () => {
    const state = openState()
    state.commitSweep({ channelId: 'chan', events: [event('e1'), event('e2')], checkpoint: 1000 })

    state.claimOutbound('e1', 'answer')
    state.markOutboundOutcome('e1', 'failed', 'HTTP 403')
    expect(state.claimOutbound('e1', 'answer').claimed).toBe(true)

    state.claimOutbound('e2', 'answer')
    state.markOutboundOutcome('e2', 'unknown', 'HTTP 504')
    expect(state.claimOutbound('e2', 'answer').claimed).toBe(false)
  })

  test('recording the sent post settles the event in the same transaction', () => {
    const state = openState()
    state.commitSweep({ channelId: 'chan', events: [event('e1'), event('e2')], checkpoint: 1000 })
    state.claimOutbound('e1', 'answer')
    state.markOutboundSent('e1', 'post-1')
    expect(state.outbound('e1')).toMatchObject({ status: 'sent', post_id: 'post-1' })
    expect(state.pending().map((e) => e.event_id)).toEqual(['e2'])
  })
})
