import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { AppruvIt } from '../nodes/AppruvIt/AppruvIt.node';

// The node's execute() and webhook() against mocked n8n contexts.

const REF = 'n8n-42-node-1-0';
const CREDENTIALS = { apiKey: 'apv_abcdefgh_x', baseUrlOverride: 'https://api.example.com/api/' };
const NODE = { id: 'node-1', name: 'AppruvIt', type: 'n8n-nodes-appruvit.appruvIt', typeVersion: 1, position: [0, 0], parameters: {} };

type Http = (options: { method: string; url: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ statusCode: number; body: unknown }>;

function webhookContext(body: unknown, query: Record<string, string>, http: Http) {
	const res = { statusCode: 0, sent: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(data: unknown) { this.sent = data; return this; } };
	const context = {
		getQueryData: () => query,
		getBodyData: () => body,
		getResponseObject: () => res,
		getCredentials: async () => CREDENTIALS,
		getNode: () => NODE,
		helpers: { httpRequestWithAuthentication: vi.fn((_name: string, options: Parameters<Http>[0]) => http(options)) },
	};
	return { context, res };
}

const view = (overrides: Record<string, unknown> = {}) => ({
	requestId: 'abc123', reference: REF, status: 'approved', approved: true, cancelReason: null,
	decidedAt: '2026-10-27T12:00:00.000Z', decisions: [], ...overrides,
});

describe('webhook()', () => {
	const node = new AppruvIt();
	const body = { requestId: 'abc123', reference: REF, status: 'approved' };

	it('fetches the request with the API key and routes the confirmed result', async () => {
		const http = vi.fn<Http>(async () => ({ statusCode: 200, body: view({ status: 'rejected', approved: false }) }));
		const { context, res } = webhookContext(body, { ref: REF }, http);
		const result = await node.webhook.call(context as never);
		expect(http).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: 'https://api.example.com/api/v1/requests/abc123' }));
		expect(res.statusCode).toBe(0);
		expect(result.workflowData).toHaveLength(1);
		expect(result.workflowData?.[0][0].json).toMatchObject({ status: 'rejected', approved: false, data: { approved: false } });
	});

	it('answers 503 and does not run the workflow when AppruvIt is unreachable', async () => {
		const { context, res } = webhookContext(body, { ref: REF }, async () => {
			throw new Error('getaddrinfo EAI_AGAIN');
		});
		const result = await node.webhook.call(context as never);
		expect(res.statusCode).toBe(503);
		expect(result).toEqual({ noWebhookResponse: true });
	});

	it('answers 503 when AppruvIt returns a server error', async () => {
		const { context, res } = webhookContext(body, { ref: REF }, async () => ({ statusCode: 502, body: 'Bad gateway' }));
		expect(await node.webhook.call(context as never)).toEqual({ noWebhookResponse: true });
		expect(res.statusCode).toBe(503);
	});

	it('answers 400 and does not run the workflow for a forged or mismatched callback', async () => {
		const cases: Array<[unknown, Record<string, string>, Http]> = [
			[{ ...body, reference: 'someone-else' }, { ref: REF }, async () => ({ statusCode: 200, body: view() })],
			[body, { ref: REF }, async () => ({ statusCode: 200, body: view({ reference: 'n8n-7-node-1-0' }) })],
			[body, { ref: REF }, async () => ({ statusCode: 404, body: { error: { code: 'not_found' } } })],
			[body, { ref: REF }, async () => ({ statusCode: 200, body: view({ status: 'pending' }) })],
			[{ hello: 'world' }, { ref: REF }, async () => ({ statusCode: 200, body: view() })],
		];
		for (const [callback, query, http] of cases) {
			const { context, res } = webhookContext(callback, query, http);
			expect(await node.webhook.call(context as never)).toEqual({ noWebhookResponse: true });
			expect(res.statusCode).toBe(400);
		}
	});
});

function executeContext(parameters: Record<string, unknown>, http: Http, extra: Record<string, unknown> = {}) {
	const get = (name: string, _i: number, fallback?: unknown) => {
		const value = name.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], parameters);
		return value === undefined ? fallback : value;
	};
	return {
		getNodeParameter: vi.fn(get),
		getInputData: () => [{ json: {} }],
		getExecutionId: () => '42',
		getNode: () => NODE,
		getWorkflow: () => ({ id: 'wf1', name: 'PO approvals', active: true }),
		getInstanceBaseUrl: () => 'https://n8n.example.com/',
		getWorkflowDataProxy: () => ({ $runIndex: 0 }),
		getSignedResumeUrl: vi.fn((params: Record<string, string>) => `https://n8n.example.com/webhook-waiting/42/node-1?ref=${params.ref}&signature=sig`),
		putExecutionToWait: vi.fn(async () => undefined),
		getCredentials: async () => CREDENTIALS,
		continueOnFail: () => false,
		helpers: { httpRequestWithAuthentication: vi.fn((_name: string, options: Parameters<Http>[0]) => http(options)) },
		...extra,
	};
}

const createParameters = {
	operation: 'sendAndWait',
	title: 'PO-1',
	summary: 'AED 900',
	approvers: 'a@w.com',
	rule: 'any',
	options: {},
};

describe('execute(): Send and Wait for Approval', () => {
	it('creates the request with its signed resume URL and waits with no time limit', async () => {
		let sent: Parameters<Http>[0] | undefined;
		const context = executeContext(createParameters, async (options) => {
			sent = options;
			return { statusCode: 201, body: { id: 'abc123', status: 'pending', expiresAt: '2026-11-03T12:00:00.000Z' } };
		});
		const outputs = await new AppruvIt().execute.call(context as never);

		expect(context.getSignedResumeUrl).toHaveBeenCalledWith({ ref: REF });
		expect(sent?.url).toBe('https://api.example.com/api/v1/requests');
		expect(sent?.headers).toMatchObject({ 'Idempotency-Key': REF });
		expect(sent?.body).toMatchObject({
			reference: REF,
			callback: { url: `https://n8n.example.com/webhook-waiting/42/node-1?ref=${REF}&signature=sig` },
		});
		const waitTill = (context.putExecutionToWait.mock.calls[0] as unknown as [Date])[0];
		expect(waitTill.toISOString()).toBe('3000-01-01T00:00:00.000Z'); // n8n's WAIT_INDEFINITELY
		// Shown while waiting, to find the request; approved is false.
		expect(outputs).toEqual([[{ json: { requestId: 'abc123', reference: REF, status: 'pending', approved: false }, pairedItem: { item: 0 } }]]);
	});

	it('shows AppruvIt\'s own message when the request is refused, and does not wait', async () => {
		const context = executeContext(createParameters, async () => ({
			statusCode: 422,
			body: { error: { code: 'approver_not_member', message: 'Not members of this workspace: a@w.com' } },
		}));
		const run = new AppruvIt().execute.call(context as never);
		await expect(run).rejects.toBeInstanceOf(NodeApiError);
		await expect(run).rejects.toThrow('Not members of this workspace: a@w.com');
		expect(context.putExecutionToWait).not.toHaveBeenCalled();
	});

	it('reports this run\'s workflow details', async () => {
		let sent: Parameters<Http>[0] | undefined;
		const context = executeContext(createParameters, async (options) => {
			sent = options;
			return { statusCode: 201, body: { id: 'abc123', status: 'pending', expiresAt: '2026-11-03T12:00:00.000Z' } };
		});
		await new AppruvIt().execute.call(context as never);
		expect(sent?.body).toMatchObject({
			workflow: {
				platform: 'n8n',
				id: 'wf1',
				name: 'PO approvals',
				executionId: '42',
				step: 'AppruvIt',
				instanceUrl: 'https://n8n.example.com/',
			},
		});
	});

	it('sends the chosen category', async () => {
		let sent: Parameters<Http>[0] | undefined;
		const context = executeContext({ ...createParameters, options: { category: 'expense' } }, async (options) => {
			sent = options;
			return { statusCode: 201, body: { id: 'abc123', status: 'pending', expiresAt: '2026-11-03T12:00:00.000Z' } };
		});
		await new AppruvIt().execute.call(context as never);
		expect(sent?.body).toMatchObject({ category: 'expense' });
	});

	it('sends attachments as multipart', async () => {
		let sent: Parameters<Http>[0] | undefined;
		const pdf = Buffer.from('%PDF-1.4 x');
		const context = executeContext({ ...createParameters, options: { attachments: 'data' } }, async (options) => {
			sent = options;
			return { statusCode: 201, body: { id: 'abc123', status: 'pending', expiresAt: '2026-11-03T12:00:00.000Z' } };
		});
		Object.assign(context.helpers, {
			assertBinaryData: () => ({ fileName: 'quote.pdf', mimeType: 'application/pdf' }),
			getBinaryDataBuffer: async () => pdf,
		});
		await new AppruvIt().execute.call(context as never);
		expect(Buffer.isBuffer(sent?.body)).toBe(true);
		const contentType = sent?.headers?.['Content-Type'] ?? '';
		const form = await new Response(sent?.body as Buffer, { headers: { 'Content-Type': contentType } }).formData();
		expect(JSON.parse(form.get('request') as string)).toMatchObject({ reference: REF });
		expect((form.get('file') as File).name).toBe('quote.pdf');
	});
});

describe('node description', () => {
	it('offers exactly the API\'s categories, defaulting to General', () => {
		const options = new AppruvIt().description.properties.find((p) => p.name === 'options');
		const category = (options?.options as Array<{ name: string; default?: unknown; options?: Array<{ value: string }> }>).find(
			(o) => o.name === 'category',
		);
		expect(category?.default).toBe('general');
		expect(category?.options?.map((o) => o.value).sort()).toEqual(
			['purchase', 'payment', 'expense', 'leave', 'access', 'content', 'deployment', 'contract', 'ai_action', 'general'].sort(),
		);
	});

	it('has one output and no wait-limit option', () => {
		const { description } = new AppruvIt();
		expect(description.outputs).toEqual(['main']);
		expect(description.properties.map((p) => p.name)).not.toContain('limitWaitTime');
		expect(description.properties.find((p) => p.name === 'operation')?.options).toContainEqual(expect.objectContaining({ value: 'sendAndWait' }));
	});
});

describe('execute(): Get Many', () => {
	const pages = [
		{ requests: [{ requestId: 'r5' }, { requestId: 'r4' }], nextCursor: 'c1' },
		{ requests: [{ requestId: 'r3' }, { requestId: 'r2' }], nextCursor: 'c2' },
		{ requests: [{ requestId: 'r1' }], nextCursor: null },
	];
	const paged = (urls: string[]): Http => async (options) => {
		urls.push(options.url);
		const cursor = new URL(options.url).searchParams.get('cursor');
		return { statusCode: 200, body: pages[cursor === null ? 0 : cursor === 'c1' ? 1 : 2] };
	};

	it('follows nextCursor to the end with Return All, one item per request', async () => {
		const urls: string[] = [];
		const out = await new AppruvIt().execute.call(
			executeContext({ operation: 'getAll', returnAll: true, filters: { status: 'pending', category: 'purchase' } }, paged(urls)) as never,
		);
		expect(out[0].map((i) => i.json.requestId)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
		expect(urls).toHaveLength(3);
		const first = new URL(urls[0]);
		expect(first.pathname).toBe('/api/v1/requests');
		expect(Object.fromEntries(first.searchParams)).toEqual({ status: 'pending', category: 'purchase', limit: '100' });
	});

	it('stops at the limit, asking only for what is still needed', async () => {
		const urls: string[] = [];
		const out = await new AppruvIt().execute.call(executeContext({ operation: 'getAll', returnAll: false, limit: 3 }, paged(urls)) as never);
		// Never more than the limit, even if a page returns extra.
		expect(out[0].map((i) => i.json.requestId)).toEqual(['r5', 'r4', 'r3']);
		expect(urls.map((u) => new URL(u).searchParams.get('limit'))).toEqual(['3', '1']);
	});
});

describe('execute(): Get and Cancel', () => {
	it('calls the matching endpoint', async () => {
		const calls: string[] = [];
		const http: Http = async (options) => {
			calls.push(`${options.method} ${options.url}`);
			return { statusCode: 200, body: { id: 'abc123', status: 'cancelled' } };
		};
		await new AppruvIt().execute.call(executeContext({ operation: 'get', requestId: 'abc123' }, http) as never);
		await new AppruvIt().execute.call(executeContext({ operation: 'cancel', requestId: 'abc123' }, http) as never);
		expect(calls).toEqual(['GET https://api.example.com/api/v1/requests/abc123', 'POST https://api.example.com/api/v1/requests/abc123/cancel']);
	});
});
