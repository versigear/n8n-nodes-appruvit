import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, WAIT_INDEFINITELY } from 'n8n-workflow';

import { apiBaseUrl } from '../../credentials/AppruvItApi.credentials';

import { properties } from './description';
import {
	attachmentFileName,
	buildCreateBody,
	checkAttachmentLimits,
	type CreateParams,
	type FetchResponse,
	listQuery,
	type ListFilters,
	resultOutput,
	verifyCallback,
	waitReference,
	workflowDetails,
} from './logic';
import { buildMultipart, type FilePart } from './multipart';


type TimeLimit = CreateParams['expiry'];
type Context = IExecuteFunctions | IWebhookFunctions;

const CREDENTIAL = 'appruvItApi';

async function apiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	options: Pick<IHttpRequestOptions, 'body' | 'headers'> = {},
): Promise<FetchResponse> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const baseUrl = apiBaseUrl(credentials.baseUrlOverride);
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
		method,
		url: `${baseUrl}${path}`,
		...options,
		json: !Buffer.isBuffer(options.body),
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode: number; body: unknown };
	let body = response.body;
	if (Buffer.isBuffer(body)) body = body.toString('utf8');
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			// Not JSON (e.g. a proxy error page); keep the text.
		}
	}
	return { statusCode: response.statusCode, body };
}

/** The response body, or a NodeApiError carrying AppruvIt's own message. */
function expectOk(this: IExecuteFunctions, response: FetchResponse, itemIndex: number): IDataObject {
	if (response.statusCode >= 200 && response.statusCode < 300) return response.body as IDataObject;
	const error = (response.body as { error?: { code?: string; message?: string } })?.error;
	throw new NodeApiError(this.getNode(), (response.body ?? {}) as JsonObject, {
		itemIndex,
		httpCode: String(response.statusCode),
		message: error?.message ?? `AppruvIt answered ${response.statusCode}`,
		description: error?.code,
	});
}

function timeLimit(this: IExecuteFunctions, name: string, itemIndex: number): TimeLimit {
	const values = this.getNodeParameter(`${name}.values`, itemIndex, null) as IDataObject | null;
	if (!values) return undefined;
	if (values.type === 'at') return { type: 'at', date: String(values.date) };
	return {
		type: 'after',
		amount: Number(values.amount ?? 1),
		unit: (values.unit as 'minutes' | 'hours' | 'days') ?? 'days',
	};
}

function thisRun(this: IExecuteFunctions) {
	const workflow = this.getWorkflow();
	return workflowDetails({
		workflowId: workflow.id,
		workflowName: workflow.name,
		executionId: this.getExecutionId(),
		nodeName: this.getNode().name,
		instanceBaseUrl: this.getInstanceBaseUrl(),
	});
}

/** GET /v1/requests, following nextCursor until the limit (or the end). */
async function listRequests(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const filters = this.getNodeParameter('filters', itemIndex, {}) as ListFilters;
	const results: IDataObject[] = [];
	let cursor: string | null = null;
	do {
		const pageSize = Math.min(100, limit - results.length);
		const response = await apiRequest.call(this, 'GET', `/v1/requests?${listQuery(filters, pageSize, cursor)}`);
		const page = expectOk.call(this, response, itemIndex) as { requests: IDataObject[]; nextCursor: string | null };
		results.push(...page.requests);
		cursor = page.nextCursor;
	} while (cursor && results.length < limit);
	return results.slice(0, limit);
}

function createParams(this: IExecuteFunctions, itemIndex: number): CreateParams {
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const facts = ((options.keyFacts as IDataObject)?.fact as Array<{ label: string; value: string }>) ?? [];
	return {
		title: this.getNodeParameter('title', itemIndex) as string,
		summary: this.getNodeParameter('summary', itemIndex) as string,
		approvers: this.getNodeParameter('approvers', itemIndex) as string,
		rule: this.getNodeParameter('rule', itemIndex) as CreateParams['rule'],
		requiredApprovals: this.getNodeParameter('requiredApprovals', itemIndex, 1) as number,
		requestedBy: options.requestedBy as string | undefined,
		bodyFormat: options.bodyFormat as CreateParams['bodyFormat'],
		bodyContent: options.bodyContent as string | undefined,
		keyFacts: facts,
		priority: options.priority as CreateParams['priority'],
		commentOnReject: options.commentOnReject as CreateParams['commentOnReject'],
		category: options.category as string | undefined,
		workflow: thisRun.call(this),
		expiry: options.expiry ? timeLimit.call(this, 'options.expiry', itemIndex) : undefined,
	};
}

async function attachmentsFor(this: IExecuteFunctions, itemIndex: number): Promise<FilePart[]> {
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	if (options.attachments === undefined) return [];
	const names = String(options.attachments)
		.split(',')
		.map((n) => n.trim())
		.filter((n) => n !== '');
	const files: FilePart[] = [];
	for (const property of names) {
		const binary = this.helpers.assertBinaryData(itemIndex, property);
		const data = await this.helpers.getBinaryDataBuffer(itemIndex, property);
		files.push({
			name: attachmentFileName(property, binary.fileName, binary.mimeType),
			mimeType: binary.mimeType,
			data,
		});
	}
	try {
		checkAttachmentLimits(files.map((f) => ({ name: f.name, size: f.data.length })));
	} catch (error) {
		throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
	}
	return files;
}

/** POST /v1/requests, as JSON or (with attachments) multipart. */
async function createRequest(
	this: IExecuteFunctions,
	itemIndex: number,
	body: IDataObject,
	idempotencyKey?: string,
): Promise<IDataObject> {
	const files = await attachmentsFor.call(this, itemIndex);
	const headers: IDataObject = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
	let response: FetchResponse;
	if (files.length > 0) {
		const multipart = buildMultipart(body, files);
		response = await apiRequest.call(this, 'POST', '/v1/requests', {
			body: multipart.body,
			headers: { ...headers, 'Content-Type': multipart.contentType },
		});
	} else {
		response = await apiRequest.call(this, 'POST', '/v1/requests', { body, headers });
	}
	return expectOk.call(this, response, itemIndex);
}

async function sendAndWait(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	// One request per execution, from the first item, as n8n's own send-and-wait nodes.
	const runIndex = Number(this.getWorkflowDataProxy(0).$runIndex ?? 0);
	const reference = waitReference(this.getExecutionId(), this.getNode().id, runIndex);
	const resumeUrl = this.getSignedResumeUrl({ ref: reference });

	const body = buildCreateBody({ ...createParams.call(this, 0), reference, callbackUrl: resumeUrl });
	const created = await createRequest.call(this, 0, body, reference);

	// No n8n-side wait limit: if n8n resumed on a timer, it would pass this
	// node's input through unchanged. The request's own expiry ends the wait
	// instead: AppruvIt calls back with `expired` (and retries for 24 hours).
	await this.putExecutionToWait(WAIT_INDEFINITELY);
	// Shown on the node while it waits, so the request can be found (Get, Cancel).
	// n8n doesn't pass this on when it resumes; the verified result replaces it.
	return [
		[
			{
				json: { requestId: created.id as string, reference, status: 'pending', approved: false },
				pairedItem: { item: 0 },
			},
		],
	];
}

// webhook-lifecycle-complete is for trigger nodes that register webhooks with
// another service. This webhook is n8n's own resume URL for a waiting
// execution (as in n8n's send-and-wait nodes): there is nothing to register.
// eslint-disable-next-line @n8n/community-nodes/webhook-lifecycle-complete
export class AppruvIt implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AppruvIt',
		name: 'appruvIt',
		icon: { light: 'file:appruvit.svg', dark: 'file:appruvit.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Send approval requests to AppruvIt and wait for a decision made on the phone',
		defaults: { name: 'AppruvIt' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		// The resume webhook, as n8n's own send-and-wait nodes declare it.
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				responseData: '',
				path: '={{ $nodeId }}',
				restartWebhook: true,
				isFullPath: true,
			},
		],
		properties,
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const ref = (this.getQueryData() as IDataObject).ref;
		const outcome = await verifyCallback(this.getBodyData(), ref, (requestId) =>
			apiRequest.call(this, 'GET', `/v1/requests/${requestId}`),
		);
		if (outcome.action === 'route') {
			return { workflowData: resultOutput(outcome.result, new Date().toISOString()) };
		}
		// 503: AppruvIt retries the callback. 400: AppruvIt stops. The workflow doesn't run.
		const res = this.getResponseObject();
		res.status(outcome.action === 'retry' ? 503 : 400).json({ error: outcome.message });
		return { noWebhookResponse: true };
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		if (operation === 'sendAndWait') return await sendAndWait.call(this);

		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				let json: IDataObject;
				if (operation === 'getAll') {
					for (const json of await listRequests.call(this, i)) {
						results.push({ json, pairedItem: { item: i } });
					}
					continue;
				}
				if (operation === 'send') {
					const options = this.getNodeParameter('options', i, {}) as IDataObject;
					const body = buildCreateBody({
						...createParams.call(this, i),
						reference: (options.reference as string) || undefined,
						callbackUrl: (options.callbackUrl as string) || undefined,
					});
					json = await createRequest.call(this, i, body);
				} else {
					const requestId = encodeURIComponent(this.getNodeParameter('requestId', i) as string);
					const response =
						operation === 'get'
							? await apiRequest.call(this, 'GET', `/v1/requests/${requestId}`)
							: await apiRequest.call(this, 'POST', `/v1/requests/${requestId}/cancel`);
					json = expectOk.call(this, response, i);
				}
				results.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Both constructors return an error of their own type unchanged.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [results];
	}
}
