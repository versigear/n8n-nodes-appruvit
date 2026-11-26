// A stand-in for the AppruvIt API, for testing the node in a local n8n.
// The request's title picks the scenario; the mock then calls the node's
// resume URL the way AppruvIt would, and records n8n's answers.
//
//   node test/local/mock-appruvit.mjs            (listens on 127.0.0.1:5680)
//
// Scenarios: approve, reject, expire, cancel, forged, unreachable; any other
// title (e.g. "hold") gets no callback, so the execution keeps waiting.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 5680);
const API_KEY = 'apv_testtest_' + 'x'.repeat(43);

const requests = new Map();
const reports = [];
const callbacks = []; // { requestId, scenario, label, status }

const json = (res, status, body) => {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
};
const readBody = (req) =>
	new Promise((resolve) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function view(r) {
	return {
		requestId: r.id,
		reference: r.reference,
		status: r.status,
		approved: r.status === 'approved',
		cancelReason: r.status === 'cancelled' ? 'cancelled_by_workflow' : null,
		decidedAt: r.status === 'pending' ? null : new Date().toISOString(),
		decisions: r.decisions,
		title: r.title,
		createdAt: r.createdAt,
		expiresAt: r.expiresAt,
	};
}

async function callBack(r, label, body) {
	let status;
	try {
		const res = await fetch(r.callbackUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'User-Agent': 'AppruvIt-Callback/1' },
			body: JSON.stringify(body),
		});
		status = res.status;
	} catch (error) {
		status = `network error: ${error.message}`;
	}
	callbacks.push({ requestId: r.id, scenario: r.title, label, status });
	return status;
}

function decide(r, status) {
	r.status = status;
	if (status === 'approved' || status === 'rejected') {
		r.decisions = [
			{
				email: 'tester@example.com',
				decision: status,
				comment: status === 'rejected' ? 'Too expensive' : '',
				verifiedWith: 'faceid',
				at: new Date().toISOString(),
			},
		];
	}
}

async function play(r) {
	await sleep(1500); // let n8n park the execution first
	switch (r.title) {
		case 'approve':
		case 'reject':
		case 'expire':
		case 'cancel':
			decide(r, { approve: 'approved', reject: 'rejected', expire: 'expired', cancel: 'cancelled' }[r.title]);
			await callBack(r, 'genuine', view(r));
			break;
		case 'forged': {
			decide(r, 'approved');
			// Wrong reference in the body: rejected before any lookup.
			await callBack(r, 'wrong reference in body', { ...view(r), reference: 'someone-else' });
			// Right reference, but naming another request whose reference differs.
			const other = makeRequest({ title: 'other', reference: 'n8n-other-step', callback: null });
			decide(other, 'approved');
			await callBack(r, 'other request id', { ...view(other), reference: r.reference });
			// Then the genuine one still resumes the execution.
			await sleep(500);
			await callBack(r, 'genuine', view(r));
			break;
		}
		case 'unreachable':
			decide(r, 'approved');
			r.failVerifications = 2; // the node's next two lookups fail as if AppruvIt were down
			await callBack(r, 'attempt 1 (API down)', view(r));
			await sleep(1000);
			await callBack(r, 'attempt 2 (API down)', view(r));
			await sleep(1000);
			await callBack(r, 'attempt 3', view(r));
			break;
	}
}

function makeRequest(input, files = []) {
	const r = {
		id: randomBytes(10).toString('hex').slice(0, 20),
		title: input.title,
		reference: input.reference ?? null,
		callbackUrl: input.callback?.url ?? null,
		status: 'pending',
		decisions: [],
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		files,
		body: input,
		// Lookups of this request that fail as if AppruvIt were down (per request,
		// so scenarios running at the same time don't affect each other).
		failVerifications: 0,
	};
	requests.set(r.id, r);
	return r;
}

createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const raw = await readBody(req);

	// Test plumbing (no key needed).
	if (url.pathname === '/report' && req.method === 'POST') {
		reports.push(JSON.parse(raw.toString() || '{}'));
		return json(res, 200, { ok: true });
	}
	if (url.pathname === '/results') {
		return json(res, 200, {
			reports,
			callbacks,
			requests: [...requests.values()].map((r) => ({ id: r.id, title: r.title, reference: r.reference, files: r.files, body: r.body })),
		});
	}

	if (req.headers.authorization !== `Bearer ${API_KEY}`) {
		return json(res, 401, { error: { code: 'unauthorized', message: 'Missing, invalid or revoked API key.' } });
	}
	if (url.pathname === '/api/v1/me' && req.method === 'GET') {
		return json(res, 200, { workspaceId: 'ws1', workspaceName: 'Mock workspace', keyId: 'k1', keyLabel: 'local test' });
	}
	if (url.pathname === '/api/v1/requests' && req.method === 'POST') {
		let input;
		let files = [];
		const type = req.headers['content-type'] ?? '';
		if (type.startsWith('multipart/form-data')) {
			const form = await new Response(raw, { headers: { 'Content-Type': type } }).formData();
			input = JSON.parse(form.get('request'));
			files = await Promise.all(
				form.getAll('file').map(async (f) => ({ name: f.name, type: f.type, size: (await f.arrayBuffer()).byteLength })),
			);
		} else {
			input = JSON.parse(raw.toString());
		}
		const r = makeRequest(input, files);
		void play(r);
		return json(res, 201, { id: r.id, status: 'pending', expiresAt: r.expiresAt });
	}
	const one = /^\/api\/v1\/requests\/([A-Za-z0-9]+)$/.exec(url.pathname);
	if (one && req.method === 'GET') {
		const r = requests.get(one[1]);
		if (r && r.failVerifications > 0) {
			r.failVerifications--;
			return json(res, 503, { error: { code: 'unavailable', message: 'Mock outage' } });
		}
		return r ? json(res, 200, view(r)) : json(res, 404, { error: { code: 'not_found', message: 'Request not found.' } });
	}
	const cancel = /^\/api\/v1\/requests\/([A-Za-z0-9]+)\/cancel$/.exec(url.pathname);
	if (cancel && req.method === 'POST') {
		const r = requests.get(cancel[1]);
		if (!r) return json(res, 404, { error: { code: 'not_found', message: 'Request not found.' } });
		if (r.status !== 'pending') {
			return json(res, 409, { error: { code: 'already_final', message: `This request is already ${r.status}.` } });
		}
		decide(r, 'cancelled');
		if (r.callbackUrl) void sleep(500).then(() => callBack(r, 'after Cancel', view(r)));
		return json(res, 200, { id: r.id, status: 'cancelled' });
	}
	return json(res, 404, { error: { code: 'not_found', message: 'Unknown endpoint.' } });
}).listen(PORT, '127.0.0.1', () => console.log(`mock AppruvIt on http://127.0.0.1:${PORT}/api`));
