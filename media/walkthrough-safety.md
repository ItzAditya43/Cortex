## You decide how much to approve

| Setting | Behaviour |
|---|---|
| `untrusted` | Ask before every file change or command *(default)* |
| `on-request` | Auto-approve what the sandbox contains |
| `never` | Don't ask |

**Destructive commands always ask, whatever you choose.** `rm -rf`, `curl | sh`,
`sudo`, force-pushes and credential reads can't be auto-approved by any
setting — file contents reaching the model are untrusted input.

Every action is recorded: *Cortex: Show Session Audit Log*.
