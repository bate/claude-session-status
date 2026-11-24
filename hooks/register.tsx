/**
 * session-status: files this Code-tab session into a sidebar section that
 * names its state, driven by what the session does.
 *
 * Rules (main loop unless noted):
 * - the user sends a prompt                          -> In Progress
 * - a PR monitor event about review comments arrives -> Code Review: waiting for fix
 * - a test command runs (any loop)                   -> Testing, while it runs
 * - a review skill starts (pr:review, code-review)   -> Code Review
 * - AskUserQuestion is open                          -> Waiting for Feedback
 * - the turn ends:
 *     asked something (wrap_up ask, AskUserQuestion,
 *     or the answer ends in a question)              -> Waiting for Feedback
 *     review feedback not yet pushed                 -> Code Review: waiting for fix
 *     opened a PR this session                       -> Code Review
 *     otherwise                                      -> Done (In Progress when
 *                                                       the `done` option is off)
 * - `git push` after review feedback clears the pending fix.
 * - `gh pr merge` that succeeds closes the PR: the session counts as done.
 *
 * Option `folders`: `path` or `path=PREFIX`, comma-separated. Sections of a
 * folder with a prefix are named `PREFIX · <status>`.
 * - `/session-status <name>` pins a status by hand; `/session-status auto`
 *   hands it back to the rules.
 *
 * Sections are created on first use through the desktop app's sidebar MCP
 * server, so the mod does nothing outside the desktop app.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionStatus, StatusKey } from '../types'

const SIDEBAR = 'ccd_sidebar'

const NAMES: Record<StatusKey, string> = {
  'in-progress': 'In Progress',
  feedback: 'Waiting for Feedback',
  testing: 'Testing',
  review: 'Code Review',
  'review-fix': 'Code Review: waiting for fix',
  done: 'Done',
}

const KEYS = Object.keys(NAMES) as StatusKey[]

const INITIAL: SessionStatus = {
  isPinned: false,
  hasPr: false,
  isFixPending: false,
  hasAsked: false,
}

const status = atom({ plugin: 'session-status', key: 'status' } as const, INITIAL, {
  shape: 'status-1',
})

const TEST_COMMAND =
  /\b(playwright\s+test|npm\s+(run\s+)?(test|e2e)\b|npx\s+(jest|vitest|playwright)|jest\b|vitest\b|run-tests)/
const PR_CREATE = /\bgh\s+pr\s+create\b/
const GIT_PUSH = /\bgit\s+push\b/
const PR_MERGE = /\bgh\s+pr\s+merge\b/
const REVIEW_SKILL = /^(pr:review|code-review|code-review:code-review|diff-review)$/
const REVIEW_EVENT = /<ci-monitor-event[\s\S]*(review|comment|changes[_ ]requested)/i

type $ = EngineInterface

/** Section ids by name, filled from list_sections on first use. */
let sectionIds: Map<string, string> | undefined
/** Moves run one after another so a late one never overtakes a newer one. */
let queue: Promise<void> = Promise.resolve()
let hasWarned = false

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')

const loadSections = async ($: $) => {
  const listed = await $.mcp.call(SIDEBAR, 'list_sections', {})
  if (listed.isError) {
    throw new Error(textOf(listed))
  }
  const sections = JSON.parse(textOf(listed)) as { id: string; kind: string; name: string }[]

  return new Map(sections.filter(s => s.kind === 'manual').map(s => [s.name, s.id]))
}

const sectionFor = async ($: $, name: string) => {
  sectionIds ??= await loadSections($)
  const known = sectionIds.get(name)
  if (known !== undefined) {
    return known
  }
  const created = await $.mcp.call(SIDEBAR, 'create_section', { name })
  if (created.isError) {
    throw new Error(textOf(created))
  }
  const text = textOf(created)
  const id = /"id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? text.trim()
  sectionIds.set(name, id)

  return id
}

/** A section's name: the status, led by the folder's prefix when it has one. */
const sectionName = (key: StatusKey, prefix: string) =>
  prefix === '' ? NAMES[key] : `${prefix} · ${NAMES[key]}`

const fileUnder = async ($: $, name: string) => {
  const moveOnce = async () => {
    const section_id = await sectionFor($, name)
    const moved = await $.mcp.call(SIDEBAR, 'move_sessions', {
      session_ids: ['self'],
      section_id,
    })
    if (moved.isError) {
      throw new Error(textOf(moved))
    }
  }
  try {
    await moveOnce()
  } catch {
    // The user may have deleted or renamed the section: look again once.
    sectionIds = undefined
    await moveOnce()
  }
}

/** The `folders` option as register received it. */
let folderOption: unknown = ''
/** The `done` option: a finished session goes to Done, else stays In Progress. */
let isDoneOn = true

/**
 * The configured folder this session lies in, the deepest one when several
 * match; undefined when it lies in none and the mod stays out.
 */
const folderHere = async ($: $) => {
  const folders = parseFolders(folderOption, await $.env.get('HOME'))
  const paths = [await $.session.cwd(), await $.session.root()]

  return folders
    .filter(folder => paths.some(path => isInside(path, folder.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** Files the session under `key` unless it is already there or pinned. */
const setStatus = ($: $, key: StatusKey, { isManual = false } = {}) => {
  queue = queue.then(async () => {
    const folder = await folderHere($)
    if (folder === undefined) {
      return
    }
    const name = sectionName(key, folder.prefix)
    const now = await read($, status)
    if (now.isPinned && !isManual) {
      return
    }
    if (now.current === key) {
      $.ui.status(`Status: ${name}${now.isPinned ? ' (pinned)' : ''}`)

      return
    }
    try {
      await fileUnder($, name)
      await update($, status, s => ({ ...s, current: key }))
      $.ui.status(`Status: ${name}${now.isPinned || isManual ? ' (pinned)' : ''}`)
    } catch (error) {
      $.ui.status(`Status: ${name} (not filed)`)
      if (!hasWarned) {
        hasWarned = true
        $.ui.toast(`session-status: could not file the session: ${String(error).slice(0, 160)}`)
      }
    }
  })

  return queue
}

/**
 * The configured folders, each `path` or `path=PREFIX`: `~` expanded, no
 * trailing slash, the prefix trimmed ("" when none is given).
 */
const parseFolders = (raw: unknown, home: string | undefined) =>
  String(raw ?? '')
    .split(/[,\n]/)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => {
      const at = entry.indexOf('=')
      const rawPath = (at === -1 ? entry : entry.slice(0, at)).trim()
      const prefix = at === -1 ? '' : entry.slice(at + 1).trim()
      const path = (rawPath.startsWith('~/') && home ? home + rawPath.slice(1) : rawPath).replace(/\/+$/, '')

      return { path, prefix }
    })
    .filter(folder => folder.path !== '')

const isInside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`)

/** The `folders` option split into its entries as written, `~` kept. */
const folderEntries = (raw: unknown) =>
  String(raw ?? '')
    .split(/[,\n]/)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')

/** A new entry is `path` or `path=PREFIX`, the path absolute or under `~/`. */
const isValidEntry = (entry: string) => {
  const path = entry.split('=')[0]?.trim() ?? ''

  return /^(\/|~\/)/.test(path) && !entry.includes(',')
}

const PANE = 'session-status-config'

/** The rules as the config pane explains them, one line per section. */
const HELP: readonly (readonly [string, string])[] = [
  ['In Progress', 'you sent a prompt'],
  ['Testing', 'a test command runs (npm test, playwright, jest, vitest)'],
  ['Waiting for Feedback', 'the turn ends with a question to you'],
  ['Code Review', 'a PR was opened in the session, or a review skill runs'],
  ['Code Review: waiting for fix', 'review comments arrived; the next git push clears it'],
  ['Done', 'the turn ends with nothing open, or the PR was merged (optional)'],
]

/** Writes one of this mod's options as the config menu would. */
const saveOption = async ($: $, field: 'folders' | 'done', value: string | boolean) => {
  const { deny } = await $.config.set({ key: `${$.plugin.name}.${field}`, value })
  $.ui.toast(deny === undefined ? 'session-status: saved.' : `session-status: not saved: ${deny}`)
}

const isQuestion =(answer: string) => /\?\s*$/.test(answer.trim().split('\n').slice(-3).join(' '))

const parseKey = (args: string): StatusKey | 'auto' | undefined => {
  const wanted = args.trim().toLowerCase()
  if (wanted === 'auto') {
    return 'auto'
  }

  return KEYS.find(key => key === wanted || NAMES[key].toLowerCase() === wanted)
}

export const register: Register = (on, options) => {
  folderOption = options.folders
  isDoneOn = options.done !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-status',
      description: `Pin this session's status (${KEYS.join(', ')}), hand it back with "auto", or "config" to set folders and prefixes`,
    })

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const entries = folderEntries(folderOption)
    const root = await $.session.root()
    const home = (await $.env.get('HOME')) ?? ''
    const here = home !== '' && isInside(root, home) ? `~${root.slice(home.length)}` : root
    const folder = await folderHere($)
    const save = (next: string[]) => void saveOption($, 'folders', next.join(', '))

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {folder === undefined
            ? `Not active in ${here}.`
            : `Active here${folder.prefix === '' ? '' : ` with prefix ${folder.prefix}`}.`}
        </Text>
        <Text bold>How it works</Text>
        <Text dimColor>
          Sessions in the folders below are filed into sidebar sections by what they do:
        </Text>
        <Box flexDirection="column">
          {HELP.map(([section, when]) => (
            <Text key={section}>
              <Text bold>{section}</Text>
              <Text dimColor> {when}</Text>
            </Text>
          ))}
        </Box>
        <Text dimColor>
          Sections are created on first use. /session-status {'<status>'} pins a status by hand,
          /session-status auto hands it back to the rules.
        </Text>
        <Text bold>Folders</Text>
        <Text dimColor>
          One entry per project: path or path=PREFIX, e.g. ~/src/foo=FOO. Subfolders and
          worktrees count; the deepest match wins. A prefix names the sections FOO · Code
          Review and so on, so each project gets its own set.
        </Text>
        {entries.length === 0 && <Text dimColor>None yet: the mod acts nowhere.</Text>}
        {entries.map((entry, index) => (
          <Box key={`row-${index}`} flexDirection="row" gap={1}>
            <Text>{entry}</Text>
            <Button
              key={`remove-${index}`}
              plain
              onPress={() => save(entries.filter((_, at) => at !== index))}
            >
              Remove
            </Button>
          </Box>
        ))}
        <Input
          key="add"
          label="Add a folder"
          placeholder="~/src/project=PREFIX"
          submitLabel="Add"
          onSubmit={value => {
            const entry = value.trim()
            if (isValidEntry(entry)) {
              save([...entries, entry])
            } else {
              $.ui.toast('session-status: write path or path=PREFIX, the path starting with / or ~/.')
            }
          }}
        />
        {folder === undefined && (
          <Button key="add-here" onPress={() => save([...entries, here])}>
            Add this folder ({here})
          </Button>
        )}
        <Select
          key="done"
          label="Finished sessions"
          value={isDoneOn ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Go to Done' },
            { value: 'off', label: 'Stay in In Progress' },
          ]}
          onSelect={value => void saveOption($, 'done', value === 'on')}
        />
      </Box>
    )
  })

  on('command.run', { command: 'session-status' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'config') {
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'Session status' })

      return {
        text: isPlaced
          ? 'Session status settings opened beside the chat.'
          : 'This surface draws no panes: set the options in the config menu or settings.json.',
      }
    }
    const folder = await folderHere($)
    if (folder === undefined) {
      return {
        text: `session-status is off in ${await $.session.cwd()}: add the folder to the plugin's "folders" option.`,
      }
    }
    const key = parseKey(e.args)
    if (key === undefined) {
      const now = await read($, status)
      const current = now.current === undefined ? 'none' : sectionName(now.current, folder.prefix)

      return {
        text: `Status: ${current}${now.isPinned ? ' (pinned)' : ''}. Use /session-status <${KEYS.join('|')}|auto>.`,
      }
    }
    if (key === 'auto') {
      await update($, status, s => ({ ...s, isPinned: false }))

      return { text: 'Status is set by the rules again.' }
    }
    await update($, status, s => ({ ...s, isPinned: true }))
    await setStatus($, key, { isManual: true })

    return { text: `Status pinned to ${sectionName(key, folder.prefix)}.` }
  }).catch(() => ({ text: 'session-status: the command failed.' }))

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) {
      return next(e)
    }
    if (e.isMeta === true) {
      if (REVIEW_EVENT.test(e.text)) {
        await update($, status, s => ({ ...s, isFixPending: true }))
        await setStatus($, 'review-fix')
      }

      return next(e)
    }
    await update($, status, s => ({ ...s, hasAsked: false }))
    await setStatus($, 'in-progress')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const command = e.command
      if (TEST_COMMAND.test(command)) {
        await setStatus($, 'testing')
      }
      const ran = await next(e)
      const isOk = ran.deny === undefined && ran.isError !== true
      if (isOk && PR_CREATE.test(command)) {
        await update($, status, s => ({ ...s, hasPr: true, isFixPending: false }))
      }
      if (isOk && PR_MERGE.test(command)) {
        await update($, status, s => ({ ...s, hasPr: false, isFixPending: false }))
      }
      if (isOk && GIT_PUSH.test(command)) {
        await update($, status, s => ({ ...s, isFixPending: false }))
      }

      return ran
    }

    if (e.tool === 'Skill' && typeof e.skill === 'string' && REVIEW_SKILL.test(e.skill)) {
      await setStatus($, 'review')

      return next(e)
    }

    if (e.tool === 'AskUserQuestion' && e.agentId === undefined) {
      await update($, status, s => ({ ...s, hasAsked: true }))
      await setStatus($, 'feedback')
      const ran = await next(e)
      await setStatus($, 'in-progress')

      return ran
    }

    if (e.tool === 'mcp__ccd_turn__wrap_up' && e.agentId === undefined) {
      const ask = (e as { ask?: unknown }).ask
      if (typeof ask === 'string' && ask.trim() !== '') {
        await update($, status, s => ({ ...s, hasAsked: true }))
      }

      return next(e)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || e.reason !== 'answer') {
      return next(e)
    }
    const now = await read($, status)
    const key: StatusKey =
      now.hasAsked || isQuestion(e.answer)
        ? 'feedback'
        : now.isFixPending
          ? 'review-fix'
          : now.hasPr
            ? 'review'
            : isDoneOn
              ? 'done'
              : 'in-progress'
    await setStatus($, key)

    return next(e)
  }).catch(($, e, next) => next(e))
}
