import type { INodeProperties } from 'n8n-workflow';

const createOperations = ['sendAndWait', 'send'];

const timeLimitFields = (name: string, displayName: string, description: string): INodeProperties => ({
	displayName,
	name,
	type: 'fixedCollection',
	default: {},
	description,
	options: [
		{
			displayName: 'Values',
			name: 'values',
			values: [
				{
					displayName: 'Type',
					name: 'type',
					type: 'options',
					default: 'after',
					options: [
						{ name: 'After Time Interval', value: 'after' },
						{ name: 'At Specified Time', value: 'at' },
					],
				},
				{
					displayName: 'Amount',
					name: 'amount',
					type: 'number',
					default: 1,
					typeOptions: { minValue: 1 },
					displayOptions: { show: { type: ['after'] } },
				},
				{
					displayName: 'Unit',
					name: 'unit',
					type: 'options',
					default: 'days',
					options: [
						{ name: 'Minutes', value: 'minutes' },
						{ name: 'Hours', value: 'hours' },
						{ name: 'Days', value: 'days' },
					],
					displayOptions: { show: { type: ['after'] } },
				},
				{
					displayName: 'Date and Time',
					name: 'date',
					type: 'dateTime',
					default: '',
					displayOptions: { show: { type: ['at'] } },
				},
			],
		},
	],
});

export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		default: 'approvalRequest',
		options: [{ name: 'Approval Request', value: 'approvalRequest' }],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'sendAndWait',
		displayOptions: { show: { resource: ['approvalRequest'] } },
		options: [
			{
				name: 'Cancel',
				value: 'cancel',
				description: 'Cancel a pending approval request',
				action: 'Cancel an approval request',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the status and decisions of an approval request',
				action: 'Get an approval request',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List approval requests in the workspace, newest first',
				action: 'Get many approval requests',
			},
			{
				name: 'Send',
				value: 'send',
				description: 'Send an approval request and continue without waiting',
				action: 'Send an approval request',
			},
			{
				// The value must be exactly "sendAndWait": n8n checks the resume URL's
				// signature, and offers the node as AI Agent "Human review", only then.
				name: 'Send and Wait for Approval',
				value: 'sendAndWait',
				description:
					'Send an approval request and wait until it is approved, rejected, expired or cancelled',
				action: 'Send and wait for approval',
			},
		],
	},

	// Send and Send and Wait
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Purchase order PO-4471',
		description: 'Shown in the approver\'s inbox. Up to 200 characters.',
		displayOptions: { show: { operation: createOperations } },
	},
	{
		displayName: 'Summary',
		name: 'summary',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'AED 18,500 for 12 laptops',
		description: 'One line shown under the title and in notifications. Up to 500 characters.',
		displayOptions: { show: { operation: createOperations } },
	},
	{
		displayName: 'Approvers',
		name: 'approvers',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'aisha@company.com, omar@company.com',
		description:
			'Work emails of workspace members, separated by commas. Each must match a member\'s work email in AppruvIt.',
		displayOptions: { show: { operation: createOperations } },
	},
	{
		displayName: 'Approval Rule',
		name: 'rule',
		type: 'options',
		default: 'any',
		options: [
			{ name: 'Any Approver', value: 'any', description: 'One approval is enough' },
			{ name: 'All Approvers', value: 'all', description: 'Everyone must approve' },
			{ name: 'Number of Approvals', value: 'count', description: 'A set number must approve' },
		],
		description: 'The first rejection always ends the request as rejected',
		displayOptions: { show: { operation: createOperations } },
	},
	{
		displayName: 'Approvals Required',
		name: 'requiredApprovals',
		type: 'number',
		default: 2,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { operation: createOperations, rule: ['count'] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { operation: createOperations } },
		options: [
			{
				displayName: 'Attachments',
				name: 'attachments',
				type: 'string',
				default: 'data',
				description:
					'Names of the input item\'s binary properties to attach, separated by commas. Up to 10 files and 25 MB in total: PDF, PNG, JPEG, HEIC, CSV and Office documents.',
			},
			{
				displayName: 'Body Content',
				name: 'bodyContent',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				description: 'The full details, shown on the request\'s detail screen',
			},
			{
				displayName: 'Body Format',
				name: 'bodyFormat',
				type: 'options',
				default: 'markdown',
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'Markdown', value: 'markdown' },
					{ name: 'Plain Text', value: 'text' },
				],
			},
			{
				displayName: 'Callback URL',
				name: 'callbackUrl',
				type: 'string',
				default: '',
				placeholder: 'https://n8n.example.com/webhook/approval-done',
				description:
					'Send only: where AppruvIt POSTs the outcome. HTTPS and a public address only. Ignored by Send and Wait, which uses its own resume URL.',
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				default: 'general',
				description: 'Shown as an icon on the request in the app, and used to filter the inbox',
				options: [
					{ name: 'Access', value: 'access' },
					{ name: 'AI Action', value: 'ai_action' },
					{ name: 'Content', value: 'content' },
					{ name: 'Contract', value: 'contract' },
					{ name: 'Deployment', value: 'deployment' },
					{ name: 'Expense', value: 'expense' },
					{ name: 'General', value: 'general' },
					{ name: 'Leave', value: 'leave' },
					{ name: 'Payment / Invoice', value: 'payment' },
					{ name: 'Purchase', value: 'purchase' },
				],
			},
			{
				displayName: 'Comment on Reject',
				name: 'commentOnReject',
				type: 'options',
				default: 'optional',
				options: [
					{ name: 'Optional', value: 'optional' },
					{ name: 'Required', value: 'required' },
				],
			},
			timeLimitFields(
				'expiry',
				'Expires',
				'When the request expires if not decided (default 7 days, at most 30). For Send and Wait this is also how long the workflow waits: on expiry it continues with status "expired".',
			),
			{
				displayName: 'Key Facts',
				name: 'keyFacts',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description: 'Label and value pairs shown as a card above the body (up to 30)',
				options: [
					{
						displayName: 'Fact',
						name: 'fact',
						values: [
							{ displayName: 'Label', name: 'label', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'options',
				default: 'normal',
				options: [
					{ name: 'High', value: 'high' },
					{ name: 'Low', value: 'low' },
					{ name: 'Normal', value: 'normal' },
				],
			},
			{
				displayName: 'Reference',
				name: 'reference',
				type: 'string',
				default: '',
				description:
					'Send only: your own ID for this request, returned by Get and in the callback (up to 100 characters). Send and Wait sets its own.',
			},
			{
				displayName: 'Requested By',
				name: 'requestedBy',
				type: 'string',
				default: '={{ $workflow.name }}',
				description: 'Shown to approvers as the sender',
			},
		],
	},
	// Get and Cancel
	{
		displayName: 'Request ID',
		name: 'requestId',
		type: 'string',
		required: true,
		default: '',
		description: 'The ID returned when the request was sent',
		displayOptions: { show: { operation: ['get', 'cancel'] } },
	},

	// Get Many
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: { operation: ['getAll'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: { show: { operation: ['getAll'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { operation: ['getAll'] } },
		options: [
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				default: 'general',
				options: [
					{ name: 'Access', value: 'access' },
					{ name: 'AI Action', value: 'ai_action' },
					{ name: 'Content', value: 'content' },
					{ name: 'Contract', value: 'contract' },
					{ name: 'Deployment', value: 'deployment' },
					{ name: 'Expense', value: 'expense' },
					{ name: 'General', value: 'general' },
					{ name: 'Leave', value: 'leave' },
					{ name: 'Payment / Invoice', value: 'payment' },
					{ name: 'Purchase', value: 'purchase' },
				],
			},
			{
				displayName: 'Created After',
				name: 'createdAfter',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Created Before',
				name: 'createdBefore',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'pending',
				options: [
					{ name: 'Approved', value: 'approved' },
					{ name: 'Cancelled', value: 'cancelled' },
					{ name: 'Expired', value: 'expired' },
					{ name: 'Pending', value: 'pending' },
					{ name: 'Rejected', value: 'rejected' },
				],
			},
		],
	},
];
