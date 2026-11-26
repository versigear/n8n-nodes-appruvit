# Local end-to-end test (n8n 2.30.0)

Runs the node in a real n8n 2.30.0 against `mock-appruvit.mjs`, a stand-in for the AppruvIt API that calls the node's resume URL back the way AppruvIt does. No public URL needed.

Files:
- `mock-appruvit.mjs`: the mock API on `127.0.0.1:5680` (n8n's own task broker uses 5679). The request title picks the scenario: `approve`, `reject`, `expire`, `cancel`, `forged` (two forged callbacks, then the genuine one), `unreachable` (the node's first two lookups get 503), anything else (e.g. `hold`) gets no callback.
- `workflow.json`: Webhook → Convert to File (PDF with an Arabic file name) → AppruvIt (Send and Wait) → the ready-made Switch → one "Report" HTTP node per branch, posting to the mock.
- `switch-check.workflow.json`: feeds edge cases straight into the Switch (an empty item, `approved: "true"`, …).
- `credentials.json`: the mock credential (not a real key).

Steps (paths relative to an empty test folder, `$D`):

```sh
npm install n8n@2.30.0
# from this package: npm run build && npm pack --pack-destination $D
mkdir -p user/.n8n/custom/n8n-nodes-appruvit
tar xzf n8n-nodes-appruvit-0.1.0.tgz -C user/.n8n/custom/n8n-nodes-appruvit --strip-components=1
export N8N_USER_FOLDER=$D/user WEBHOOK_URL=http://localhost:5678/ N8N_ENCRYPTION_KEY=local-test-key
npx n8n import:credentials --input=credentials.json
npx n8n import:workflow --input=workflow.json
npx n8n import:workflow --input=switch-check.workflow.json
npx n8n publish:workflow --id=appruvitLocalTest1
npx n8n execute --id=appruvitSwitchCheck1 --rawOutput     # before starting n8n
node mock-appruvit.mjs &
npx n8n start &
curl -X POST http://localhost:5678/webhook/appruvit-test -H 'Content-Type: application/json' \
  -d '{"scenario":"approve","file":"<base64 PDF>"}'
curl http://127.0.0.1:5680/results        # requests, n8n's answers to callbacks, branches taken
```

Results on 2026-10-27 (n8n 2.30.0): every scenario reached its Switch branch; forged callbacks got 400 and the execution kept waiting until the genuine one; "API down" got 503 twice, then resumed; a `hold` request waited with `waitTill` 3000-01-01 and was released by the node's Cancel operation onto the Cancelled branch.
