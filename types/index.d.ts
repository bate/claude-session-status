export type StatusKey = 'in-progress' | 'feedback' | 'testing' | 'review' | 'review-fix' | 'done'

export type SessionStatus = {
  /** The status the session was last filed under, if any. */
  current?: StatusKey
  /** Set by /session-status <name>: the rules leave the session alone until /session-status auto. */
  isPinned: boolean
  /** A PR was opened in this session (gh pr create succeeded). */
  hasPr: boolean
  /** Review feedback arrived and no push has followed yet. */
  isFixPending: boolean
  /** This turn asked the user something (wrap_up ask or AskUserQuestion). */
  hasAsked: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-status': { status: Shaped<SessionStatus> }
  }
}
