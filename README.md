# Ralph Pi Extension

Global extension for PRD-linked GitHub issue implementation loops.

## Commands

- `/ralph-start` — interactive PRD picker, max issues, HITL/AFK
- `/ralph <prd> [max]` — AFK loop over issues linked from PRD body
- `/ralph-once <prd>` — implement next linked issue only
- `/ralph-status` — show `.git/ralph/state.json` ledger
- `/ralph-stop` — stop active Ralph loop
- `/ralph-resume [hitl|afk]` — continue v2 ledger
- `/ralph-clear [prd]` — delete ledger and managed v2 worktrees
- `/ralph-check` — run configured/inferred full check in integration worktree when v2 ledger exists
- `/ralph-finish` — after verifier passes, export integration to original branch, push, then close completed issues

## v2 defaults

- original checkout is control plane only and must stay clean/unchanged until `/ralph-finish`
- integration worktree is canonical result on `ralph/<runId>/integration`
- each issue runs in isolated worktree/branch `ralph/<runId>/issue-<n>`
- workers do not commit; Ralph commits successful diffs and serially merges worker branches into integration
- conflicts spawn `ralph-conflict-resolver` in integration worktree, bounded by `maxConflictResolverAttempts`
- after all issues merge, `ralph-prd-verifier` runs read-only in integration
- verifier/check failure spawns `ralph-fixer` in integration, bounded by `maxVerifierFixAttempts`
- `/ralph-finish` refuses while workers, merge queue, conflict resolver, verifier, or fixer are active
- `/ralph-finish` requires original branch still at start HEAD unless already exported
- old v1 shared-worktree ledgers are not migrated; status/finish/reset still work, resume refuses

## Optional config

Create `~/.pi/agent/extensions/ralph/config.json`:

```json
{
  "fullCheckCommand": "bun check",
  "checkTimeoutMs": 600000,
  "setupCommand": "pnpm install --frozen-lockfile",
  "setupTimeoutMs": 600000,
  "workerAgent": "ralph-worker",
  "workerModel": "openai-codex/gpt-5.5",
  "conflictResolverAgent": "ralph-conflict-resolver",
  "conflictResolverModel": "openai-codex/gpt-5.5",
  "prdVerifierAgent": "ralph-prd-verifier",
  "prdVerifierModel": "openai-codex/gpt-5.5",
  "fixerAgent": "ralph-fixer",
  "fixerModel": "openai-codex/gpt-5.5",
  "maxConcurrent": 3,
  "maxConflictResolverAttempts": 2,
  "maxVerifierFixAttempts": 3,
  "maxProviderRetries": 3,
  "contextWarnTokens": 90000,
  "contextCompactTokens": 100000,
  "contextHardStopTokens": 115000
}
```

## AFK loop behavior

Ralph is never-idle by design: every recoverable condition auto-recovers and the loop dispatches
the next state-machine step itself, so the coordinator (main thread) is never left idle to
improvise. All retries are bounded by `maxIterations` so a broken step cannot run forever.

- **The coordinator never spawns its own subagents.** While a Ralph ledger exists (active or
  stopped), any main-thread subagent call that is not one of Ralph's own state-machine spawns is
  blocked. Ralph drives all delegation with the correct model/cwd/task; a hand-rolled spawn is how
  a wrong-model verifier got launched. Ralph's own spawns (reserved names) always pass.
- **Dirty integration worktree is auto-cleaned**, not fatal: tracked churn is restored and
  untracked junk removed (`git clean -fd`, which leaves `.gitignore`d paths like `node_modules`).
  The loop continues; it only stops if cleaning genuinely cannot resolve it.
- **Crashes auto-retry, bounded by `maxIterations`:** a verifier that exits nonzero / returns
  malformed output is re-launched; a fixer that fails re-enters the bounded fix loop; a worker
  that crashes is re-spawned (its worktree cleaned first). On exhaustion Ralph stops cleanly.
- **Blocked work is skipped, not fatal (AFK).** A worker reporting `Status: blocked` (or asking
  for help) is recorded and skipped; the loop continues with the next issue. HITL is decided by the
  PRD up front, so an AFK run never halts on a blocker — it finishes everything it can and the
  final report lists every blocked issue and why. (In HITL mode a help request still surfaces to
  you and waits for `/ralph-resume`.)
- The verifier→fixer loop keeps running until the PRD verifier passes. Its bound is `maxIterations` (the master autonomy budget) unless `maxVerifierFixAttempts` is explicitly set in config.
- `/ralph-resume` resets the verifier-fix, conflict-resolver, provider-retry, blocked, and
  worker-retry counters, giving the loops a fresh budget and re-attempting skipped issues.
- Transient provider/transport errors (e.g. WebSocket drop, "subagent did not produce a result") are not logical failures: Ralph re-spawns the same step immediately, bounded by `maxProviderRetries` (default 3), without consuming the verifier-fix or conflict-resolver budget. The counter resets after any non-provider-error result; once exhausted, Ralph stops and `/ralph-resume` resets it.

## Worktree dependency setup

- Fresh git worktrees have no `node_modules` (gitignored), which makes package managers resolve stray global tool versions instead of the project's pinned ones. Ralph installs dependencies once per worktree on creation.
- The install command is inferred from the lockfile (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`; plain install if no lockfile). Override with `setupCommand`; set `setupCommand` to `""` to disable. Timeout via `setupTimeoutMs` (default 600000).
- Worker/fixer/conflict-resolver subagents are instructed never to run tooling migrations (e.g. `biome migrate`) or modify lockfiles / tool config (`biome.json`, `tsconfig.json`, `package.json`, …) unless the issue/PRD requires it — a check failing on a tooling/version mismatch must be reported as blocked, not "fixed" by mutating the environment.
