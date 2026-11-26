import { describe, expect, it } from 'vitest';

import { APPRUVIT_API_URL, apiBaseUrl } from '../credentials/AppruvItApi.credentials';

import {
	attachmentFileName,
	buildCreateBody,
	checkAttachmentLimits,
	parseApprovers,
	resultOutput,
	toResult,
	verifyCallback,
	listQuery,
	waitReference,
	workflowDetails,
} from '../nodes/AppruvIt/logic';
import { buildMultipart } from '../nodes/AppruvIt/multipart';

const REF = 'n8n-42-node-1-0';
const view = (overrides: Record<string, unknown> = {}) => ({
	requestId: 'abc123',
	reference: REF,
	status: 'approved',
	approved: true,
	cancelReason: null,
	decidedAt: '2026-10-27T12:00:00.000Z',
	decisions: [{ email: 'a@w.com', decision: 'approved', comment: '', verifiedWith: 'faceid', at: '2026-10-27T12:00:00.000Z' }],
	title: 'PO-1',
	...overrides,
});
const ok = (body: unknown) => async () => ({ statusCode: 200, body });

describe('request body', () => {
	it('maps parameters to the API body', () => {
		const body = buildCreateBody({
			title: 'PO-1',
			summary: 'AED 900',
			approvers: 'A@Work.com, b@work.com\nb@work.com',
			rule: 'count',
			requiredApprovals: 2,
			requestedBy: 'PO workflow',
			bodyFormat: 'markdown',
			bodyContent: '**Hi**',
			keyFacts: [{ label: 'Amount', value: 'AED 900' }],
			priority: 'high',
			commentOnReject: 'required',
			expiry: { type: 'after', amount: 2, unit: 'hours' },
			reference: REF,
			callbackUrl: 'https://n8n.example.com/webhook-waiting/42/node-1?ref=x&signature=y',
			category: 'purchase',
		});
		expect(body).toEqual({
			title: 'PO-1',
			summary: 'AED 900',
			approvers: ['a@work.com', 'b@work.com'],
			rule: { type: 'count', required: 2 },
			requestedBy: 'PO workflow',
			body: { format: 'markdown', content: '**Hi**' },
			fields: [{ label: 'Amount', value: 'AED 900' }],
			options: { priority: 'high', commentOnReject: 'required' },
			expiresIn: 7200,
			reference: REF,
			callback: { url: 'https://n8n.example.com/webhook-waiting/42/node-1?ref=x&signature=y' },
			category: 'purchase',
		});
	});

	it('is identical on retry (relative expiry), so the Idempotency-Key replays', () => {
		const params = { title: 't', summary: 's', approvers: 'a@w.com', rule: 'any' as const, expiry: { type: 'after' as const, amount: 1, unit: 'days' as const } };
		expect(JSON.stringify(buildCreateBody(params))).toBe(JSON.stringify(buildCreateBody(params)));
	});

	it('leaves optional parts out', () => {
		expect(buildCreateBody({ title: 't', summary: 's', approvers: 'a@w.com', rule: 'all' })).toEqual({
			title: 't',
			summary: 's',
			approvers: ['a@w.com'],
			rule: { type: 'all' },
		});
	});

	it('parses approver lists', () => {
		expect(parseApprovers(' a@w.com;B@w.com ,, c@w.com ')).toEqual(['a@w.com', 'b@w.com', 'c@w.com']);
	});

	it('gives each run of a node its own reference', () => {
		expect(waitReference('42', 'node-1', 0)).toBe('n8n-42-node-1-0');
		expect(waitReference('42', 'node-1', 1)).not.toBe(waitReference('42', 'node-1', 0));
		expect(waitReference('99999999', '0f6b7e5e-2c1d-4c55-8f1e-5a2d3b4c6e7f', 999).length).toBeLessThanOrEqual(100);
	});
});

describe('attachments', () => {
	it('keeps a file name with an extension, else adds one from the type', () => {
		expect(attachmentFileName('data', 'quote.pdf', 'application/pdf')).toBe('quote.pdf');
		expect(attachmentFileName('invoice', undefined, 'application/pdf')).toBe('invoice.pdf');
		expect(attachmentFileName('photo', 'IMG_1', 'image/jpeg')).toBe('IMG_1.jpg');
		expect(attachmentFileName('sheet', undefined, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('sheet.xlsx');
		expect(attachmentFileName('blob', undefined, 'application/zip')).toBe('blob');
	});

	it('enforces 10 files and 25 MB before sending', () => {
		expect(() => checkAttachmentLimits(Array.from({ length: 11 }, () => ({ name: 'a.pdf', size: 1 })))).toThrow(/at most 10/);
		expect(() => checkAttachmentLimits([{ name: 'a.pdf', size: 25 * 1024 * 1024 + 1 }])).toThrow(/25 MB/);
		expect(() => checkAttachmentLimits([{ name: 'a.pdf', size: 25 * 1024 * 1024 }])).not.toThrow();
	});

	it('builds multipart that a standard parser reads back', async () => {
		const pdf = Buffer.from('%PDF-1.4 test');
		const { body, contentType } = buildMultipart({ title: 'PO-1' }, [
			{ name: 'quote.pdf', mimeType: 'application/pdf', data: pdf },
			{ name: 'we"ird\r\n.csv', mimeType: 'text/csv', data: Buffer.from('a,b\n1,2\n') },
		]);
		const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
		expect(JSON.parse(form.get('request') as string)).toEqual({ title: 'PO-1' });
		const files = form.getAll('file') as File[];
		expect(files.map((f) => f.name)).toEqual(['quote.pdf', 'we_ird__.csv']);
		expect(Buffer.from(await files[0].arrayBuffer()).equals(pdf)).toBe(true);
	});
});

describe('result output', () => {
	it('puts every result on the one output, with the built-in data shape', () => {
		for (const status of ['approved', 'rejected', 'expired', 'cancelled']) {
			const outputs = resultOutput(toResult(view({ status, approved: status === 'approved' })), '2026-10-27T12:00:01.000Z');
			expect(outputs).toHaveLength(1);
			expect(outputs[0][0].json).toMatchObject({ status, approved: status === 'approved', data: { approved: status === 'approved', respondedAt: '2026-10-27T12:00:01.000Z' } });
		}
	});

	it('sets approved to true only for an approved decision', () => {
		expect(toResult(view({ status: 'approved', approved: true })).approved).toBe(true);
		for (const status of ['rejected', 'expired', 'cancelled']) {
			// Even if a response claimed approved: true, only the status counts.
			expect(toResult(view({ status, approved: true })).approved).toBe(false);
		}
		expect(toResult(view({ status: 'approved', approved: 'true' })).approved).toBe(false);
		expect(toResult(view({ status: 'approved', approved: undefined })).approved).toBe(false);
	});
});

describe('callback verification', () => {
	const body = { requestId: 'abc123', reference: REF, status: 'approved' };

	it('routes only what AppruvIt confirms, using the fetched data', async () => {
		let asked = '';
		const outcome = await verifyCallback({ ...body, status: 'rejected' }, REF, async (id) => {
			asked = id;
			return { statusCode: 200, body: view() };
		});
		expect(asked).toBe('abc123');
		expect(outcome).toMatchObject({ action: 'route', result: { status: 'approved', approved: true, title: 'PO-1' } });
	});

	it('503 (retry) when AppruvIt cannot be reached or answers 5xx, 429 or 401', async () => {
		const down = await verifyCallback(body, REF, async () => {
			throw new Error('ECONNRESET');
		});
		expect(down).toMatchObject({ action: 'retry' });
		for (const statusCode of [500, 503, 429, 401]) {
			expect(await verifyCallback(body, REF, async () => ({ statusCode, body: {} }))).toMatchObject({ action: 'retry' });
		}
		expect(await verifyCallback(body, REF, ok('<html>proxy</html>'))).toMatchObject({ action: 'retry' });
	});

	it('400 (stop) for forged or mismatched callbacks', async () => {
		const never = async () => {
			throw new Error('must not be called');
		};
		expect(await verifyCallback(body, undefined, never)).toMatchObject({ action: 'reject' });
		expect(await verifyCallback('not json', REF, never)).toMatchObject({ action: 'reject' });
		expect(await verifyCallback({ ...body, requestId: '../../v1/me' }, REF, never)).toMatchObject({ action: 'reject' });
		expect(await verifyCallback({ ...body, reference: 'other' }, REF, never)).toMatchObject({ action: 'reject' });
		// The body claims our reference, but the request it names belongs to another step.
		expect(await verifyCallback(body, REF, ok(view({ reference: 'n8n-41-node-1-0' })))).toMatchObject({ action: 'reject' });
		expect(await verifyCallback(body, REF, ok(view({ status: 'pending' })))).toMatchObject({ action: 'reject' });
		expect(await verifyCallback(body, REF, async () => ({ statusCode: 404, body: {} }))).toMatchObject({ action: 'reject' });
	});
});

describe('workflow details', () => {
	it('cuts long values to the API limits and drops a base URL that is not http(s)', () => {
		const details = workflowDetails({
			workflowId: 'wf1',
			workflowName: 'n'.repeat(250),
			executionId: '42',
			nodeName: 'AppruvIt',
			instanceBaseUrl: 'file:///etc/',
		});
		expect(details.name).toHaveLength(200);
		expect(details.instanceUrl).toBeNull();
		expect(workflowDetails({ instanceBaseUrl: 'http://nas.tailnet:5678/' }).instanceUrl).toBe('http://nas.tailnet:5678/');
		expect(workflowDetails({}).id).toBeNull();
	});
});

describe('list query', () => {
	it('sends only the filters that are set, dates as ISO', () => {
		expect(listQuery({}, 25, null)).toBe('limit=25');
		const q = new URLSearchParams(listQuery({ status: 'approved', createdAfter: '2026-10-01T00:00:00Z' }, 100, 'abc'));
		expect(Object.fromEntries(q)).toEqual({ status: 'approved', createdAfter: '2026-10-01T00:00:00.000Z', limit: '100', cursor: 'abc' });
	});
});

describe('apiBaseUrl', () => {
	it('uses the built-in address when the override is empty or missing', () => {
		expect(apiBaseUrl('')).toBe(APPRUVIT_API_URL);
		expect(apiBaseUrl('   ')).toBe(APPRUVIT_API_URL);
		expect(apiBaseUrl(undefined)).toBe(APPRUVIT_API_URL);
		expect(APPRUVIT_API_URL).toBe('https://me-central1-appruvit.cloudfunctions.net/api');
	});
	it('uses the override, without trailing slashes', () => {
		expect(apiBaseUrl(' http://127.0.0.1:5680/api/ ')).toBe('http://127.0.0.1:5680/api');
	});
	it('ignores the earlier baseUrl field saved in old credentials', () => {
		const saved = { apiKey: 'apv_x', baseUrl: 'https://old.example.com/api' } as Record<string, unknown>;
		expect(apiBaseUrl(saved.baseUrlOverride)).toBe(APPRUVIT_API_URL);
	});
});
