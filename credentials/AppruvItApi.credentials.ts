import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * AppruvIt's API address, built into the node rather than saved in each
 * credential, so a future move is a node update with no credential edits.
 */
export const APPRUVIT_API_URL = 'https://me-central1-appruvit.cloudfunctions.net/api';

/** The address to call: the credential's override if set, otherwise the built-in one. */
export function apiBaseUrl(override: unknown): string {
	const custom = typeof override === 'string' ? override.trim() : '';
	return (custom || APPRUVIT_API_URL).replace(/\/+$/, '');
}

export class AppruvItApi implements ICredentialType {
	name = 'appruvItApi';

	displayName = 'AppruvIt API';

	icon: Icon = {
		light: 'file:../nodes/AppruvIt/appruvit.svg',
		dark: 'file:../nodes/AppruvIt/appruvit.dark.svg',
	};

	documentationUrl = 'https://appruvit.com/docs/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Created in the AppruvIt app: Workspaces → your workspace → Integrations. It starts with apv_ and is shown only once.',
		},
		{
			// A new field: the earlier `baseUrl` held the address itself, and n8n
			// keeps that value in saved credentials, which would pin them to it.
			displayName: 'Custom API Address',
			name: 'baseUrlOverride',
			type: 'string',
			default: '',
			placeholder: 'Leave empty',
			description:
				'Leave empty to use AppruvIt. Only for testing against another AppruvIt server.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: `={{(($credentials.baseUrlOverride || "").trim() || "${APPRUVIT_API_URL}").replace(/\\/+$/, "")}}`,
			url: '/v1/me',
			method: 'GET',
		},
	};
}
