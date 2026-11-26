# n8n-nodes-appruvit

An n8n node for [AppruvIt](https://appruvit.com): send approval requests to approvers' phones and continue the workflow when they decide. Each decision is confirmed on the phone with a fingerprint, Face ID or Touch ID.

Built and tested against **n8n 2.30.0 and 2.48.1**.

## Operations (resource: Approval Request)

| Operation | What it does |
|---|---|
| **Send and Wait for Approval** | Creates the request and pauses the workflow until the request is approved, rejected, expired or cancelled, then continues with the result. |
| **Send** | Creates the request and continues immediately with its `id`. Optional callback URL. |
| **Get** | Status, decisions and cancel reason of a request. |
| **Get Many** | Requests in the workspace, newest first, one item per request. Filters: Status, Category, Created After / Before. **Return All**, or a **Limit**. |
| **Cancel** | Cancels a pending request (409 if it's already decided). |

Send and Wait handles one request per execution, from the first input item (like n8n's own send-and-wait nodes). For several approvals, use **Loop Over Items**.

The result item has `requestId`, `reference`, `status` (`approved`, `rejected`, `expired` or `cancelled`), `approved`, `cancelReason`, `decidedAt`, `decisions` (email, decision, comment, verifiedWith, emailVerified, emailVerifiedBy, at) and `data: { approved, respondedAt }` (the shape of n8n's built-in send-and-wait nodes).

`approved` is `true` only for an approved request and `false` for everything else, so even a plain IF on `approved` is safe.

In each decision, `emailVerified` says whether the approver's work email was verified when they decided: the account they signed in with (Google, Apple, or Microsoft) vouches for that exact address. `emailVerifiedBy` says how (`google`, `apple`, `microsoft-personal`, `microsoft-edov`), or is `null`. Decisions made before this existed have `emailVerified: false`.

**How long it waits:** until the request ends. Set **Options → Expires** (default 7 days, at most 30); when it expires, AppruvIt calls back and the workflow continues with `status: "expired"`. There is no separate n8n wait limit, on purpose: if n8n resumed on its own timer, it would pass the node's *input* item through unchanged, with no result in it.

## Branching on the result: the ready-made Switch

The node has one output, like n8n's own send-and-wait nodes (n8n resumes a waiting node in a way that only passes on its first output). Put a Switch after it to branch. A ready-made one is in [`examples/route-decision-switch.json`](examples/route-decision-switch.json): copy the file's contents and paste them onto the n8n canvas (Ctrl/Cmd+V), then connect the AppruvIt node to it.

| Output | Rule |
|---|---|
| **Approved** | `$json.approved === true && $json.status === 'approved'` |
| **Rejected** | `status` is `rejected` |
| **Expired** | `status` is `expired` |
| **Cancelled** | `status` is `cancelled` (check `cancelReason`) |
| **Other** | anything else, including an item with no result at all |

Each rule is an expression that always returns a value, so an item missing these fields goes to **Other** instead of making the Switch fail. Tested in n8n 2.30.0: only a real approval reaches Approved; an empty item, `approved: "true"` (a string) and `status: "approved"` without `approved: true` all go to Other.

The node also appears as **Human review** for an AI Agent's tools: n8n offers every node with a "Send and Wait" operation there.

## Credential: AppruvIt API

- **API Key:** create one in the AppruvIt web console ([console.appruvit.com](https://console.appruvit.com): API keys → Create key) or in the app (Workspaces → your workspace → Integrations → Create Key). It is shown once.
- **Custom API Address:** leave it empty. The node has AppruvIt's address built in, so when it changes, updating the node is enough. (This replaces the earlier Base URL field; credentials saved with it keep working and need no edit.)

The credential test calls `GET /v1/me`.

## Workflow details ("Sent by")

Every create (Send, and Send and Wait) also sends this run's details: the workflow's ID and name, the execution ID, the node's name and your n8n's base URL. You don't fill these in. In the app, approvers see the API key's label (checked by AppruvIt) and these details (marked "Reported by the workflow, not verified"). Owners and admins also get **Open in n8n**, which shows the link's host first.

The base URL is n8n's editor URL (`N8N_EDITOR_BASE_URL`) if set, otherwise its webhook URL (`N8N_WEBHOOK_URL` / `WEBHOOK_URL`). If you open the editor at a different address (for example over Tailscale), set `N8N_EDITOR_BASE_URL` to it. The link opens the execution only if n8n saves executions.

## Category

Under **Options → Category**, pick what kind of request it is: Purchase, Payment / Invoice, Expense, Leave, Access, Content, Deployment, Contract, AI Action or General (the default). The app shows it as an icon on the request and lets approvers filter by it. Requests sent without one are General.

## Attachments

Under **Options → Attachments**, list the input item's binary properties (for example `data, invoice`). Up to 10 files and 25 MB in total. Accepted: PDF, PNG, JPEG, HEIC, CSV and Office documents, with a file extension that matches the content (AppruvIt checks the content, not the name). File names in any language are kept.

## How waiting works, and why it's safe

1. The node asks n8n for a signed resume URL for this execution (`?ref=…&signature=…`, an HMAC with your instance's secret) and sends it to AppruvIt as the callback, with the same `ref` as the request's `reference`.
2. n8n pauses the execution.
3. When the request is decided, AppruvIt POSTs the result to that URL. n8n rejects the call (401) unless the signature is valid.
4. The node does not trust the body. It fetches the request from AppruvIt with your API key and checks that its `reference` is the one signed into the URL. Only then does the workflow continue.
   - AppruvIt can't be reached, or answers an error: the node answers **503**, and AppruvIt retries for up to 24 hours.
   - The callback doesn't match: the node answers **400**, and AppruvIt stops.

Your n8n must be reachable over **HTTPS** at its `WEBHOOK_URL` (AppruvIt only calls public HTTPS addresses), and `/webhook-waiting/*` must not be behind a login or bot challenge.

## Clearing an execution that's still waiting

An execution waits until AppruvIt calls back. That normally happens when the request is decided, expires or is cancelled. It can be left waiting if AppruvIt couldn't reach your n8n for more than 24 hours after the request ended, if the API key was revoked or the workspace deleted, or if you no longer want the approval.

1. **Find it:** in n8n, open **Executions** and filter by status **Waiting**. Open the execution: while it waits, the AppruvIt node shows `requestId` (with `status: "pending"`).
2. **Check the request** with a separate workflow (or the node's **Execute step** button): AppruvIt node, operation **Get**, Request ID = that `id`. `status` shows whether it's still `pending` or already ended.
3. **If it's still pending and you don't need it:** run the AppruvIt node with operation **Cancel** and the same Request ID. AppruvIt cancels it and calls back, and the waiting execution continues with `status: "cancelled"`, `cancelReason: "cancelled_by_workflow"` (the Switch's **Cancelled** branch). This is the cleanest way out.
4. **If it already ended, or AppruvIt can't call back** (key revoked, workspace deleted, n8n unreachable for over 24 hours): stop the execution in n8n (**Executions** → the waiting execution → **Stop**). The workflow doesn't continue; handle the outcome from Get yourself if needed.

## Install

**Self-hosted n8n:** Settings → Community Nodes → Install, and enter `n8n-nodes-appruvit`. (Or, where the in-app install isn't available, `npm install n8n-nodes-appruvit` in `~/.n8n/nodes` and restart n8n.) Then search the nodes panel for **AppruvIt**.

**n8n Cloud:** available once n8n has verified the node.

## Install on a self-hosted n8n without npm (Docker)

n8n loads custom nodes from `/home/node/.n8n/custom` at startup.

1. Build the package (on a computer with Node.js 22):
   ```sh
   npm install
   npm run build
   npm pack            # creates n8n-nodes-appruvit-<version>.tgz
   ```
2. Unpack it into the custom folder of n8n's data folder, as `custom/n8n-nodes-appruvit/`. With a mounted data folder you can do this from the host, or from the container's console:
   ```sh
   mkdir -p ~/.n8n/custom/n8n-nodes-appruvit
   tar xzf ~/.n8n/n8n-nodes-appruvit-<version>.tgz -C ~/.n8n/custom/n8n-nodes-appruvit --strip-components=1
   ```
3. Restart the container. Search the nodes panel for **AppruvIt**.

To update, replace the folder's contents with the new package and restart. To remove, delete the folder and restart.

Nodes loaded this way have the type `CUSTOM.appruvIt`. If you later install the package from npm, its type becomes `n8n-nodes-appruvit.appruvIt`, and existing workflows need the node swapped.

## Development

```sh
npm run build      # n8n-node build
npm run lint       # n8n's community-node rules
npm test           # unit tests (vitest)
```

`test/local/` has a mock AppruvIt server and a workflow for an end-to-end test in a local n8n 2.30.0; see `test/local/README.md`.

## Releasing

Set the new version in `package.json`, commit, then push a tag with the same version (for example `git tag 1.0.1 && git push origin 1.0.1`). The **Publish** GitHub Action checks that the tag matches the version, then lints, tests, builds and packs it in one job, and publishes that packed file to npm with a provenance statement in a second job that installs nothing.

## License

[MIT](LICENSE)
