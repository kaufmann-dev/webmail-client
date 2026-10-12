import { describe, expect, it } from 'vitest';
import { MailError } from '../errors';
import { decodeMessageRef } from '../message-ref';
import { check, failed, responseMessages } from './client';
import { buildFolders } from './folders';
import { attachmentIdOf, attachmentsOf, firstItem, itemsOf, partIdOf, summaryOf } from './items';
import * as request from './requests';
import { child, list } from './xml';

const NS =
	'xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
	'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" ' +
	'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"';

function soap(body: string): string {
	return `<?xml version="1.0" encoding="utf-8"?><s:Envelope ${NS}><s:Body>${body}</s:Body></s:Envelope>`;
}

describe('responseMessages', () => {
	it('returns the response messages in order and maps errors', () => {
		const messages = responseMessages(
			soap(
				'<m:GetItemResponse><m:ResponseMessages>' +
					'<m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>' +
					'<m:Items><t:Message><t:ItemId Id="A1"/></t:Message></m:Items></m:GetItemResponseMessage>' +
					'<m:GetItemResponseMessage ResponseClass="Error"><m:MessageText>gone</m:MessageText>' +
					'<m:ResponseCode>ErrorItemNotFound</m:ResponseCode><m:Items/></m:GetItemResponseMessage>' +
					'</m:ResponseMessages></m:GetItemResponse>'
			)
		);
		expect(messages).toHaveLength(2);
		expect(failed(messages[0])).toBe(false);
		expect(firstItem(messages[0])?.type).toBe('Message');
		expect(() => check(messages[1])).toThrow(new MailError('This message no longer exists.', 404));
	});

	it('reports SOAP faults', () => {
		const xml = soap(
			'<s:Fault><faultcode>a:ErrorSchemaValidation</faultcode><faultstring>Bad request</faultstring></s:Fault>'
		);
		expect(() => responseMessages(xml)).toThrow('Exchange: Bad request');
	});

	it('keeps large escaped HTML bodies intact', () => {
		const html = '<p>x &amp; y</p>'.repeat(20_000);
		const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const [message] = responseMessages(
			soap(
				'<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success">' +
					`<m:Items><t:Message><t:Body BodyType="HTML">${escaped}</t:Body></t:Message></m:Items>` +
					'</m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>'
			)
		);
		expect(firstItem(message)?.node.Body).toEqual({ '#text': html, BodyType: 'HTML' });
	});
});

function folder(id: string, parent: string, name: string, extra = ''): string {
	return (
		`<t:Folder><t:FolderId Id="${id}"/><t:ParentFolderId Id="${parent}"/>` +
		`<t:DisplayName>${name}</t:DisplayName>${extra}</t:Folder>`
	);
}

describe('buildFolders', () => {
	it('keeps visible mail folders with display paths and roles', () => {
		const [message] = responseMessages(
			soap(
				'<m:FindFolderResponse><m:ResponseMessages><m:FindFolderResponseMessage ResponseClass="Success">' +
					'<m:RootFolder IncludesLastItemInRange="true"><t:Folders>' +
					folder('in', 'root', 'Posteingang', '<t:FolderClass>IPF.Note</t:FolderClass>') +
					folder('sub', 'in', 'Schule', '<t:FolderClass>IPF.Note</t:FolderClass>') +
					folder('arc', 'root', 'Archiv', '<t:FolderClass>IPF.Note</t:FolderClass>') +
					folder('out', 'root', 'Postausgang', '<t:FolderClass>IPF.Note</t:FolderClass>') +
					folder(
						'cfg',
						'root',
						'Einstellungen',
						'<t:FolderClass>IPF.Configuration</t:FolderClass>'
					) +
					folder('cfgsub', 'cfg', 'Unter', '<t:FolderClass>IPF.Note</t:FolderClass>') +
					folder(
						'hid',
						'root',
						'Versteckt',
						'<t:FolderClass>IPF.Note</t:FolderClass><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x10f4" PropertyType="Boolean"/><t:Value>true</t:Value></t:ExtendedProperty>'
					) +
					'</t:Folders></m:RootFolder></m:FindFolderResponseMessage></m:ResponseMessages></m:FindFolderResponse>'
			)
		);
		const found = list(child(child(message, 'RootFolder'), 'Folders')?.Folder);
		const result = buildFolders(
			found,
			new Map([
				['msgfolderroot', 'root'],
				['inbox', 'in'],
				['outbox', 'out']
			])
		);
		expect(result.folders).toEqual([
			{ path: 'Posteingang', name: 'Posteingang', depth: 0, role: 'inbox' },
			{ path: 'Posteingang/Schule', name: 'Schule', depth: 1, role: null },
			{ path: 'Archiv', name: 'Archiv', depth: 0, role: 'archive' }
		]);
		expect(result.idByPath.get('Posteingang/Schule')).toBe('sub');
		expect(result.pathById.get('arc')).toBe('Archiv');
	});
});

const MESSAGE =
	'<t:Message><t:ItemId Id="AAMk/1+x=" ChangeKey="CQ"/><t:Subject>Konferenz</t:Subject>' +
	'<t:DateTimeReceived>2026-10-12T08:30:00Z</t:DateTimeReceived><t:HasAttachments>true</t:HasAttachments>' +
	'<t:IsDraft>false</t:IsDraft><t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag>' +
	'<t:Attachments><t:FileAttachment><t:AttachmentId Id="att/1+"/><t:Name>Plan.pdf</t:Name>' +
	'<t:ContentType>application/pdf</t:ContentType><t:Size>1234</t:Size><t:IsInline>false</t:IsInline></t:FileAttachment>' +
	'<t:FileAttachment><t:AttachmentId Id="att2"/><t:Name>logo.png</t:Name><t:ContentType>image/png</t:ContentType>' +
	'<t:ContentId>logo@x</t:ContentId><t:Size>10</t:Size><t:IsInline>true</t:IsInline></t:FileAttachment>' +
	'<t:ItemAttachment><t:AttachmentId Id="att3"/><t:Name>Re: Termin</t:Name><t:Size>99</t:Size>' +
	'<t:IsInline>false</t:IsInline></t:ItemAttachment></t:Attachments>' +
	'<t:IsRead>false</t:IsRead><t:From><t:Mailbox><t:Name>Direktion</t:Name>' +
	'<t:EmailAddress>direktion@schule.at</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:From>' +
	'<t:ToRecipients><t:Mailbox><t:Name>A</t:Name><t:EmailAddress>a@schule.at</t:EmailAddress></t:Mailbox>' +
	'<t:Mailbox><t:Name>B</t:Name><t:EmailAddress>b@schule.at</t:EmailAddress></t:Mailbox></t:ToRecipients>' +
	'<t:InternetMessageId>&lt;1@schule.at&gt;</t:InternetMessageId></t:Message>';

describe('items', () => {
	const [message] = responseMessages(
		soap(
			'<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success">' +
				`<m:Items>${MESSAGE}</m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>`
		)
	);
	const node = firstItem(message)!.node;

	it('maps a message to a summary with an Exchange ref', () => {
		const summary = summaryOf('acc', 'Posteingang', node, 3);
		expect(summary).toMatchObject({
			accountId: 'acc',
			cursor: 3,
			from: { name: 'Direktion', address: 'direktion@schule.at' },
			to: [
				{ name: 'A', address: 'a@schule.at' },
				{ name: 'B', address: 'b@schule.at' }
			],
			subject: 'Konferenz',
			date: '2026-10-12T08:30:00.000Z',
			unread: true,
			starred: true,
			draft: false,
			hasAttachments: true,
			messageId: '<1@schule.at>'
		});
		expect(decodeMessageRef(summary.ref)).toEqual({
			kind: 'ews',
			accountId: 'acc',
			path: 'Posteingang',
			itemId: 'AAMk/1+x='
		});
	});

	it('lists file and item attachments with URL-safe part IDs', () => {
		const attachments = attachmentsOf(node);
		expect(attachments.map((a) => [a.name, a.contentType, a.inline, a.contentId])).toEqual([
			['Plan.pdf', 'application/pdf', false, null],
			['logo.png', 'image/png', true, 'logo@x'],
			['Re: Termin', 'message/rfc822', false, null]
		]);
		const partId = partIdOf(attachments[0].id);
		expect(partId).toMatch(/^[\w-]+$/);
		expect(attachmentIdOf(partId)).toBe('att/1+');
	});

	it('collects items of every type', () => {
		const [found] = responseMessages(
			soap(
				'<m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">' +
					'<m:RootFolder IncludesLastItemInRange="false"><t:Items>' +
					'<t:Message><t:ItemId Id="1"/></t:Message><t:MeetingRequest><t:ItemId Id="2"/></t:MeetingRequest>' +
					'<t:Message><t:ItemId Id="3"/></t:Message></t:Items></m:RootFolder>' +
					'</m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>'
			)
		);
		const items = itemsOf(child(child(found, 'RootFolder'), 'Items'));
		expect(items.map((i) => i.type).sort()).toEqual(['MeetingRequest', 'Message', 'Message']);
	});
});

describe('requests', () => {
	it('filters folder views with a restriction', () => {
		expect(request.restriction({})).toBeNull();
		expect(request.restriction({ filter: 'unread' })).toBe(
			'<t:IsEqualTo><t:FieldURI FieldURI="message:IsRead"/><t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo>'
		);
		const both = request.restriction({ starred: false, since: new Date('2026-01-01T00:00:00Z') });
		expect(both).toMatch(/^<t:And><t:Not><t:IsEqualTo><t:ExtendedFieldURI PropertyTag="0x1090"/);
		expect(both).toContain('<t:Constant Value="2026-01-01T00:00:00.000Z"/>');
	});

	it('turns text searches into an escaped AQS query instead', () => {
		const xml = request.findItems(
			'F<1>',
			{ query: 'Zeugnis & Noten', from: 'a"b', filter: 'unread' },
			50,
			25
		);
		expect(xml).not.toContain('<m:Restriction>');
		expect(xml).toContain('<t:FolderId Id="F&lt;1&gt;"/>');
		expect(xml).toContain('Offset="50"');
		expect(xml).toContain(
			'<m:QueryString>Zeugnis &amp; Noten from:&quot;ab&quot; isread:false</m:QueryString>'
		);
	});

	it('updates each item under its own element name', () => {
		const xml = request.updateItems([
			{ id: 'm1', type: 'MeetingRequest', fields: [request.setIsRead(true)] }
		]);
		expect(xml).toContain('SuppressReadReceipts="true"');
		expect(xml).toContain('<t:MeetingRequest><t:IsRead>true</t:IsRead></t:MeetingRequest>');
	});

	it('marks saved drafts as unsent but not sent messages', () => {
		const mime = Buffer.from('Subject: x\r\n\r\nHi');
		expect(request.createMessage(mime, 'SaveOnly')).toContain('PropertyTag="0x0E07"');
		const send = request.createMessage(mime, 'SendAndSaveCopy');
		expect(send).not.toContain('0x0E07');
		expect(send).toContain('<t:DistinguishedFolderId Id="sentitems"/>');
		expect(send).toContain(mime.toString('base64'));
	});
});
