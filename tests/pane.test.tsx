import { expect, test } from 'claude-code/testing'

/**
 * The config pane writes the mod's own options through `$.config.set`; the
 * hooks here stand for the engine and record every write, so each test reads
 * what a press, an entry or a choice in the pane would have saved.
 */
const PANE = {
  plugin: 'session-status',
  component: 'Pane',
  requestId: 'session-status-config',
  props: {
    title: 'Session status',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const engine = (on: Parameters<Parameters<typeof test>[1]>[1], root: string) => {
  const writes: { key: string; value: unknown }[] = []
  on('session.cwd', () => ({ value: root }))
  on('session.root', () => ({ value: root }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('ui.toast', () => ({ value: undefined }))
  on('config.set', (_, e) => {
    writes.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return writes
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(
    `the pane removes, adds and switches Done (${surface})`,
    { options: { folders: '~/src/foo=FOO, ~/src/old', done: true } },
    async ($, on) => {
      const writes = engine(on, '/Users/me/src/foo/api')
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ type: 'Text', text: /prefix FOO/ }))?.text).toBe('Active here with prefix FOO.')
      expect(await ui.find({ key: 'add-here' })).toBeUndefined()

      await ui.press({ key: 'remove-1' })
      await ui.input({ key: 'add', text: '~/src/bar=BAR' })
      await ui.input({ key: 'add', text: 'relative/path' })
      await ui.select({ key: 'done', value: 'off' })

      expect(writes).toEqual([
        { key: 'session-status.folders', value: '~/src/foo=FOO' },
        { key: 'session-status.folders', value: '~/src/foo=FOO, ~/src/old, ~/src/bar=BAR' },
        { key: 'session-status.done', value: false },
      ])
      await ui.unmount()
    },
  )
}

test(
  'outside every folder the pane offers to add the one the session is in',
  { options: { folders: '' } },
  async ($, on) => {
    const writes = engine(on, '/Users/me/src/elsewhere')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /Not active/ }))?.text).toBe('Not active in ~/src/elsewhere.')
    await ui.press({ key: 'add-here' })

    expect(writes).toEqual([{ key: 'session-status.folders', value: '~/src/elsewhere' }])
    await ui.unmount()
  },
)
