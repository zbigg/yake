# Yake

Bring Makefile back to npm ecosystem.

Run `npm` tasks (or any other):
 * parallel
 * only when required files changed (you're smart enough to define it)
 * centralized *watch*, rerunning _only_ outdated tasks
 * keep your console clean (default no output for successfull tasks)

TODO, rest of story inspired by https://mystor.github.io/git-revise.html

## Introducing `yake`!

Yake is task runner tries to follow goold-old Makefile principle:
 * we've got files,
 * we've got commands
 * we've got more files (rinse and repeat)

So, we track dependencies between tasks, we track files they generate and run following tasks only
if prerequisities are ready - also in watch mode.

Never start 3 watchers in one folder (resource hog).
Never scratch your head over spurious build errors, if there are race conditions between 3 parallel,
non-synchronized watchers.

## It's robust

Minimal setup doesn't require plugins and tinkering with arcane, APIs. It just runs commands.

(we don't even mention about anticipated build-server architecture instead of plugins that to
 support almost native speed integration with `...ify`, `...pack`, `...lup`)

##
