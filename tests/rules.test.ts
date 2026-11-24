import { expect, test } from 'claude-code/testing'

/**
 * The hooks beneath the mod stand for the engine: the sidebar MCP server is
 * answered here and every move it is asked for is recorded, so each test
 * reads which section the session was filed under.
 */
const engine = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  cwd: string,
  agents: { id: string; status: string; parentId?: string }[] = [],
) => {
  const moves: string[] = []
  const sections = new Map<string, string>()
  on('command.register', () => ({ value: { command: 'session-status' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: cwd }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('clock.now', () => ({ value: 1000 }))
  on('agent.list', () => ({
    value: agents.map(agent => ({ description: 'x', type: 'general-purpose', kind: 'local_agent', ...agent })),
  }))
  on('classic.Stop', () => ({}))
  on('mcp.call', (_, e) => {
    const text = (value: unknown) => ({
      value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false },
    })
    if (e.tool === 'list_sections') {
      return text([...sections].map(([name, id]) => ({ id, kind: 'manual', name })))
    }
    if (e.tool === 'create_section') {
      const id = `g${sections.size}`
      sections.set(String(e.args?.name), id)

      return text({ id })
    }
    const id = String(e.args?.section_id)
    moves.push([...sections].find(([, known]) => known === id)?.[0] ?? id)

    return text({ ok: true })
  })

  return moves
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test(
  'a PR opened in the session files it under Code Review at the turn end',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo/frontend/.claude/worktrees/x')
    await $.session.start(start)
    await $.prompt.submit({ text: 'open the PR' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await $.turn.complete({ answer: 'PR is open.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

    expect(moves).toEqual(['In Progress', 'Code Review'])
  },
)

test(
  'a turn ending in a question files the session under Waiting for Feedback',
  { options: { folders: '/Users/me/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo')
    await $.session.start(start)
    await $.prompt.submit({ text: 'look at it' })
    await $.turn.complete({ answer: 'Shall I fix it?', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

    expect(moves).toEqual(['In Progress', 'Waiting for Feedback'])
  },
)

test(
  'a session outside the configured folders is never moved',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/other')
    await $.session.start(start)
    await $.prompt.submit({ text: 'hi' })
    await $.turn.complete({ answer: 'Done?', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

    expect(moves).toEqual([])
  },
)

const finished = { answer: 'Fixed.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

test(
  'a folder with a prefix names its sections after it, the deepest folder winning',
  { options: { folders: '~/src=SRC, ~/src/foo=FOO' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo/api')
    await $.session.start(start)
    await $.prompt.submit({ text: 'fix it' })
    await $.turn.complete(finished)

    expect(moves).toEqual(['FOO · In Progress', 'FOO · Done'])
  },
)

test(
  'a merged PR leaves the session done',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo')
    await $.session.start(start)
    await $.prompt.submit({ text: 'ship it' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12 --squash' })
    await $.turn.complete(finished)

    expect(moves).toEqual(['In Progress', 'Done'])
  },
)

test(
  'with the done option off a finished session stays In Progress',
  { options: { folders: '~/src/foo', done: false } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo')
    await $.session.start(start)
    await $.prompt.submit({ text: 'fix it' })
    await $.turn.complete(finished)

    expect(moves).toEqual(['In Progress'])
  },
)

test('with no folders configured the mod does nothing', async ($, on) => {
  const moves = engine(on, '/Users/me/src/foo')
  await $.session.start(start)
  await $.prompt.submit({ text: 'hi' })

  expect(moves).toEqual([])
})

test(
  'a turn ending while a subagent still runs keeps the session In Progress',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo', [{ id: 'a1', status: 'running' }])
    await $.session.start(start)
    await $.prompt.submit({ text: 'analyse it' })
    await $.turn.complete(finished)

    expect(moves).toEqual(['In Progress'])
  },
)

test(
  'a finished subagent no longer holds the session back from Done',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo', [{ id: 'a1', status: 'completed' }])
    await $.session.start(start)
    await $.prompt.submit({ text: 'analyse it' })
    await $.turn.complete(finished)

    expect(moves).toEqual(['In Progress', 'Done'])
  },
)

test(
  'background work reported by Stop before the turn end keeps the session In Progress',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo')
    await $.session.start(start)
    await $.prompt.submit({ text: 'run the workflow' })
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [{ id: 'w1', type: 'workflow', status: 'running', description: 'review' }],
    })
    await $.turn.complete(finished)

    expect(moves).toEqual(['In Progress'])
  },
)

test(
  'background work reported by Stop after the turn end moves the session back from Done',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo')
    await $.session.start(start)
    await $.prompt.submit({ text: 'run the workflow' })
    await $.turn.complete(finished)
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [{ id: 'w1', type: 'workflow', status: 'running', description: 'review' }],
    })

    expect(moves).toEqual(['In Progress', 'Done', 'In Progress'])
  },
)

test(
  'background work does not pull a waiting question back to In Progress',
  { options: { folders: '~/src/foo' } },
  async ($, on) => {
    const moves = engine(on, '/Users/me/src/foo')
    await $.session.start(start)
    await $.prompt.submit({ text: 'analyse it' })
    await $.turn.complete({ ...finished, answer: 'Which one first?' })
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'build' }],
    })

    expect(moves).toEqual(['In Progress', 'Waiting for Feedback'])
  },
)
