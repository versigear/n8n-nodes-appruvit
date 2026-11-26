import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

// Pure helpers for the AppruvIt node: request bodies, result routing and
// callback verification. Kept free of n8n contexts so they can be unit-tested.

export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const FINAL_STATUSES = ['approved', 'rejected', 'expired', 'cancelled'];
const REQUEST_ID = /^[A-Za-z0-9]{1,64}$/;

export type ApprovalResult = {
	requestId: string;
	reference: string | null;
	status: string;
	approved: boolean;
	cancelReason: string | null;
	decidedAt: string | null;
	decisions: IDataObject[];
	title?: string;
	createdAt?: string;
	expiresAt?: string;
};

export type CreateParams = {
	title: string;
	summary: string;
	approvers: string;
	rule: 'any' | 'all' | 'count';
	requiredApprovals?: number;
	requestedBy?: string;
	bodyFormat?: 'text' | 'markdown' | 'html';
	bodyContent?: string;
	keyFacts?: Array<{ label: string; value: string }>;
	priority?: 'low' | 'normal' | 'high';
	commentOnReject?: 'required' | 'optional';
	expiry?: { type: 'after'; amount: number; unit: 'minutes' | 'hours' | 'days' } | { type: 'at'; date: string };
	reference?: string;
	callbackUrl?: string;
	/** One of the API's categories; AppruvIt stores `general` when it's left out. */
	category?: string;
	/** Sent on every create; reported by the workflow, not verified by AppruvIt. */
	workflow?: WorkflowDetails;
};

export type WorkflowDetails = {
	platform: 'n8n';
	id: string | null;
	name: string | null;
	executionId: string | null;
	step: string | null;
	instanceUrl: string | null;
};

const clip = (value: string | undefined | null, max: number): string | null =>
	value ? value.slice(0, max) : null;

/**
 * This run's details for AppruvIt's "Sent by" and "Open in n8n". Cut to the
 * API's limits so a long workflow name never makes the request fail. The base
 * URL is n8n's editor URL (N8N_EDITOR_BASE_URL), else its webhook URL.
 */
export function workflowDetails(input: {
	workflowId?: string;
	workflowName?: string;
	executionId?: string;
	nodeName?: string;
	instanceBaseUrl?: string;
}): WorkflowDetails {
	const url = input.instanceBaseUrl && /^https?:\/\//.test(input.instanceBaseUrl) ? input.instanceBaseUrl : null;
	return {
		platform: 'n8n',
		id: clip(input.workflowId, 100),
		name: clip(input.workflowName, 200),
		executionId: clip(input.executionId, 100),
		step: clip(input.nodeName, 200),
		instanceUrl: url && url.length <= 500 ? url : null,
	};
}

export type ListFilters = {
	status?: string;
	category?: string;
	createdAfter?: string;
	createdBefore?: string;
};

/** The query string for one page of GET /v1/requests. */
export function listQuery(filters: ListFilters, limit: number, cursor: string | null): string {
	const params = new URLSearchParams();
	if (filters.status) params.set('status', filters.status);
	if (filters.category) params.set('category', filters.category);
	if (filters.createdAfter) params.set('createdAfter', new Date(filters.createdAfter).toISOString());
	if (filters.createdBefore) params.set('createdBefore', new Date(filters.createdBefore).toISOString());
	params.set('limit', String(limit));
	if (cursor) params.set('cursor', cursor);
	return params.toString();
}

const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 };

/** "a@x.com, b@x.com" or one per line → lowercased, de-duplicated list. */
export function parseApprovers(raw: string): string[] {
	const emails = raw
		.split(/[\s,;]+/)
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e !== '');
	return [...new Set(emails)];
}

/** The JSON body for POST /v1/requests. */
export function buildCreateBody(p: CreateParams): IDataObject {
	const body: IDataObject = {
		title: p.title,
		summary: p.summary,
		approvers: parseApprovers(p.approvers),
		rule: p.rule === 'count' ? { type: 'count', required: p.requiredApprovals ?? 1 } : { type: p.rule },
	};
	if (p.requestedBy) body.requestedBy = p.requestedBy;
	if (p.bodyContent) body.body = { format: p.bodyFormat ?? 'text', content: p.bodyContent };
	if (p.keyFacts?.length) body.fields = p.keyFacts.map((f) => ({ label: f.label, value: f.value }));
	const options: IDataObject = {};
	if (p.priority) options.priority = p.priority;
	if (p.commentOnReject) options.commentOnReject = p.commentOnReject;
	if (Object.keys(options).length) body.options = options;
	if (p.expiry?.type === 'after') {
		// Relative, so a retry sends the same body for the same Idempotency-Key.
		body.expiresIn = Math.round(p.expiry.amount * UNIT_SECONDS[p.expiry.unit]);
	} else if (p.expiry?.type === 'at') {
		body.expiresAt = new Date(p.expiry.date).toISOString();
	}
	if (p.reference) body.reference = p.reference;
	if (p.callbackUrl) body.callback = { url: p.callbackUrl };
	if (p.category) body.category = p.category;
	if (p.workflow) body.workflow = p.workflow;
	return body;
}

/**
 * The reference and idempotency key for one Send and Wait run. The same
 * execution, node and run always get the same value, so an n8n retry replays
 * the original request instead of creating another.
 */
export function waitReference(executionId: string, nodeId: string, runIndex: number): string {
	return `n8n-${executionId}-${nodeId}-${runIndex}`;
}

/** File name with an extension the server will accept, from the binary's own name or type. */
export function attachmentFileName(property: string, fileName?: string, mimeType?: string): string {
	if (fileName && /\.[A-Za-z0-9]+$/.test(fileName)) return fileName;
	const extensions: Record<string, string> = {
		'application/pdf': 'pdf',
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/heic': 'heic',
		'text/csv': 'csv',
		'application/msword': 'doc',
		'application/vnd.ms-excel': 'xls',
		'application/vnd.ms-powerpoint': 'ppt',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
	};
	const extension = mimeType ? extensions[mimeType.split(';')[0].trim()] : undefined;
	const base = fileName || property;
	return extension ? `${base}.${extension}` : base;
}

/** Throws if the files can't be sent; the server checks again. */
export function checkAttachmentLimits(files: Array<{ name: string; size: number }>): void {
	if (files.length > MAX_FILES) {
		throw new Error(`AppruvIt accepts at most ${MAX_FILES} attachments; this item has ${files.length}.`);
	}
	const total = files.reduce((sum, f) => sum + f.size, 0);
	if (total > MAX_TOTAL_BYTES) {
		const mb = (total / (1024 * 1024)).toFixed(1);
		throw new Error(`AppruvIt accepts at most 25 MB of attachments in total; these are ${mb} MB.`);
	}
}

const isObject = (value: unknown): value is IDataObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The API's request view, reduced to the result the node outputs. */
export function toResult(view: IDataObject): ApprovalResult {
	return {
		requestId: view.requestId as string,
		reference: (view.reference as string | null) ?? null,
		status: view.status as string,
		// Strictly true only for an approved decision, so a plain IF on `approved` is safe.
		approved: view.status === 'approved' && view.approved === true,
		cancelReason: (view.cancelReason as string | null) ?? null,
		decidedAt: (view.decidedAt as string | null) ?? null,
		decisions: Array.isArray(view.decisions) ? (view.decisions as IDataObject[]) : [],
		...(typeof view.title === 'string' ? { title: view.title } : {}),
		...(typeof view.createdAt === 'string' ? { createdAt: view.createdAt } : {}),
		...(typeof view.expiresAt === 'string' ? { expiresAt: view.expiresAt } : {}),
	};
}

/**
 * The node's single output. n8n resumes a waiting node as disabled, which
 * passes on only its first output, so results can't be split across outputs;
 * a Switch after the node does that. `data` matches n8n's built-in
 * send-and-wait shape.
 */
export function resultOutput(result: ApprovalResult, respondedAt: string): INodeExecutionData[][] {
	return [[{ json: { ...result, data: { approved: result.approved, respondedAt } }, pairedItem: { item: 0 } }]];
}

export type FetchResponse = { statusCode: number; body: unknown };

export type VerifyOutcome =
	| { action: 'route'; result: ApprovalResult }
	/** Couldn't check with AppruvIt: answer 503 so AppruvIt retries. */
	| { action: 'retry'; message: string }
	/** Not a genuine callback for this step: answer 400 so AppruvIt stops. */
	| { action: 'reject'; message: string };

/**
 * Decides what to do with a callback. The body is never trusted: the request
 * is fetched from AppruvIt with the API key, and its reference must equal the
 * one signed into this step's resume URL. Nothing is routed without that check.
 */
export async function verifyCallback(
	body: unknown,
	signedRef: unknown,
	fetchRequest: (requestId: string) => Promise<FetchResponse>,
): Promise<VerifyOutcome> {
	if (typeof signedRef !== 'string' || signedRef === '') {
		return { action: 'reject', message: 'The resume URL has no reference.' };
	}
	if (!isObject(body) || typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) {
		return { action: 'reject', message: 'The callback has no valid requestId.' };
	}
	if (body.reference !== signedRef) {
		return { action: 'reject', message: 'The callback is for a different workflow step.' };
	}

	let response: FetchResponse;
	try {
		response = await fetchRequest(body.requestId);
	} catch (error) {
		return { action: 'retry', message: `AppruvIt could not be reached: ${(error as Error).message}` };
	}
	if (response.statusCode === 404) {
		return { action: 'reject', message: 'AppruvIt has no such request for this API key.' };
	}
	// 401 (key revoked or changed), 429 and 5xx: the callback may be genuine; let AppruvIt retry.
	if (response.statusCode < 200 || response.statusCode >= 300) {
		return { action: 'retry', message: `AppruvIt answered ${response.statusCode} when checking the request.` };
	}
	const view = response.body;
	if (!isObject(view) || view.requestId !== body.requestId) {
		return { action: 'retry', message: 'AppruvIt returned an unexpected response when checking the request.' };
	}
	if (view.reference !== signedRef) {
		return { action: 'reject', message: 'The request belongs to a different workflow step.' };
	}
	if (!FINAL_STATUSES.includes(view.status as string)) {
		return { action: 'reject', message: `The request is still ${String(view.status)}.` };
	}
	return { action: 'route', result: toResult(view) };
}
