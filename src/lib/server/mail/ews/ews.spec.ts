import { describe, expect, it } from 'vitest';
import { MessageGoneError } from '../errors';
import { decodeMessageRef } from '../message-ref';
import { check, failed, operationResponse, responseMessages } from './client';
import { availabilityOf, organizedMeetingOf } from './calendar';
import { buildFolders } from './folders';
import {
	attachmentIdOf,
	attachmentsOf,
	firstItem,
	inTransit,
	itemsOf,
	partIdOf,
	summaryOf,
	timeCursors,
	timePosition
} from './items';
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
		expect(() => check(messages[1])).toThrow(new MessageGoneError());
	});

	it('reports SOAP faults', () => {
		const xml = soap(
			'<s:Fault><faultcode>a:ErrorSchemaValidation</faultcode><faultstring>Bad request</faultstring></s:Fault>'
		);
		expect(() => responseMessages(xml)).toThrow('Exchange: Bad request');
	});

	it('keeps large escaped HTML bodies intact', () => {
		const html = '<p>x &amp; y&#xD;\nz</p>'.repeat(20_000);
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

	it('decodes numeric character references once', () => {
		const [message] = responseMessages(
			soap(
				'<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success">' +
					'<m:Items><t:Message><t:TextBody BodyType="Text">Hallo&#xD;\nGr&#252;&#xDF;e &amp;#xD;</t:TextBody>' +
					'</t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>'
			)
		);
		expect(firstItem(message)?.node.TextBody).toEqual({
			'#text': 'Hallo\r\nGrüße &#xD;',
			BodyType: 'Text'
		});
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
					folder('sub', 'in', 'Projekte', '<t:FolderClass>IPF.Note</t:FolderClass>') +
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
			{ path: 'Posteingang/Projekte', name: 'Projekte', depth: 1, role: null },
			{ path: 'Archiv', name: 'Archiv', depth: 0, role: 'archive' }
		]);
		expect(result.idByPath.get('Posteingang/Projekte')).toBe('sub');
		expect(result.pathById.get('arc')).toBe('Archiv');
	});
});

const MESSAGE =
	'<t:Message><t:ItemId Id="AAMk/1+x=" ChangeKey="CQ"/><t:Subject>Meeting</t:Subject>' +
	'<t:DateTimeReceived>2026-10-12T08:30:00Z</t:DateTimeReceived><t:HasAttachments>true</t:HasAttachments>' +
	'<t:IsDraft>false</t:IsDraft><t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag>' +
	'<t:Attachments><t:FileAttachment><t:AttachmentId Id="att/1+"/><t:Name>Plan.pdf</t:Name>' +
	'<t:ContentType>application/pdf</t:ContentType><t:Size>1234</t:Size><t:IsInline>false</t:IsInline></t:FileAttachment>' +
	'<t:FileAttachment><t:AttachmentId Id="att2"/><t:Name>logo.png</t:Name><t:ContentType>image/png</t:ContentType>' +
	'<t:ContentId>logo@x</t:ContentId><t:Size>10</t:Size><t:IsInline>true</t:IsInline></t:FileAttachment>' +
	'<t:ItemAttachment><t:AttachmentId Id="att3"/><t:Name>Re: Termin</t:Name><t:Size>99</t:Size>' +
	'<t:IsInline>false</t:IsInline></t:ItemAttachment></t:Attachments>' +
	'<t:IsRead>false</t:IsRead><t:From><t:Mailbox><t:Name>Office</t:Name>' +
	'<t:EmailAddress>office@example.org</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:From>' +
	'<t:ToRecipients><t:Mailbox><t:Name>A</t:Name><t:EmailAddress>a@example.org</t:EmailAddress></t:Mailbox>' +
	'<t:Mailbox><t:Name>B</t:Name><t:EmailAddress>b@example.org</t:EmailAddress></t:Mailbox></t:ToRecipients>' +
	'<t:InternetMessageId>&lt;1@example.org&gt;</t:InternetMessageId></t:Message>';

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
			from: { name: 'Office', address: 'office@example.org' },
			to: [
				{ name: 'A', address: 'a@example.org' },
				{ name: 'B', address: 'b@example.org' }
			],
			subject: 'Meeting',
			date: '2026-10-12T08:30:00.000Z',
			unread: true,
			starred: true,
			draft: false,
			hasAttachments: true,
			messageId: '<1@example.org>'
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

	it('recognizes items Exchange is still sending', () => {
		expect(inTransit({ IsSubmitted: 'true', IsDraft: 'true' })).toBe(true);
		expect(inTransit({ IsSubmitted: 'false', IsDraft: 'true' })).toBe(false);
		expect(inTransit({ IsSubmitted: 'true', IsDraft: 'false' })).toBe(false);
		expect(inTransit(node)).toBe(false);
	});

	it('pages by received time, counting messages that share a second', () => {
		const at = (iso: string) => Date.parse(iso);
		const second = at('2026-10-29T15:00:00Z') / 1000;
		const cursors = timeCursors(
			[at('2026-10-29T15:00:00.900Z'), at('2026-10-29T15:00:00Z'), at('2026-10-29T14:59:59Z')],
			undefined
		);
		expect(cursors).toEqual([
			second * 1_000_000 + 1,
			second * 1_000_000 + 2,
			(second - 1) * 1_000_000 + 1
		]);
		// The next page ends with that second and skips the one tie listed already.
		const next = timePosition(cursors[1] - 1);
		expect(next).toEqual({ before: new Date((second + 1) * 1000), skip: 1 });
		// Its messages in the same second continue the count.
		expect(timeCursors([at('2026-10-29T15:00:00Z')], cursors[1] - 1)).toEqual([cursors[1]]);
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
			{ query: 'Budget & Plan', from: 'a"b', filter: 'unread' },
			50,
			25
		);
		expect(xml).not.toContain('<m:Restriction>');
		expect(xml).toContain('<t:FolderId Id="F&lt;1&gt;"/>');
		expect(xml).toContain('Offset="50"');
		expect(xml).toContain(
			'<m:QueryString>Budget &amp; Plan from:(a b) isread:false</m:QueryString>'
		);
		// Words in parentheses match anywhere in the field, unlike a quoted phrase.
		expect(request.queryString({ subject: 'Budget' })).toBe('subject:(Budget)');
		expect(request.queryString({ subject: ' Der "Plan" (neu) ' })).toBe('subject:(Der Plan neu)');
		expect(request.queryString({ query: 'invoice', since: new Date('2026-10-04T13:00:00Z') })).toBe(
			'invoice received:>=10/4/2026'
		);
	});

	it('moves folders below a parent or to the top level by escaped ID', () => {
		expect(request.moveFolder('F"1', 'P1')).toBe(
			'<m:MoveFolder><m:ToFolderId><t:FolderId Id="P1"/></m:ToFolderId>' +
				'<m:FolderIds><t:FolderId Id="F&quot;1"/></m:FolderIds></m:MoveFolder>'
		);
		expect(request.moveFolder('F1')).toContain(
			'<m:ToFolderId><t:DistinguishedFolderId Id="msgfolderroot"/></m:ToFolderId>'
		);
	});

	it('creates, renames, and deletes folders by escaped ID and name', () => {
		expect(request.createFolder('A&B')).toContain(
			'<m:ParentFolderId><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderId>'
		);
		const nested = request.createFolder('Q<1>', 'F"1');
		expect(nested).toContain('<m:ParentFolderId><t:FolderId Id="F&quot;1"/></m:ParentFolderId>');
		expect(nested).toContain('<t:DisplayName>Q&lt;1&gt;</t:DisplayName>');
		expect(request.renameFolder('F1', 'New & improved')).toContain(
			'<t:FolderId Id="F1"/><t:Updates><t:SetFolderField><t:FieldURI FieldURI="folder:DisplayName"/>' +
				'<t:Folder><t:DisplayName>New &amp; improved</t:DisplayName></t:Folder>'
		);
		expect(request.deleteFolder('F1')).toBe(
			'<m:DeleteFolder DeleteType="HardDelete"><m:FolderIds><t:FolderId Id="F1"/></m:FolderIds></m:DeleteFolder>'
		);
	});

	it('counts the messages of a folder and its subfolders', () => {
		expect(request.folderTotal('F1')).toContain(
			'<t:FieldURI FieldURI="folder:TotalCount"/></t:AdditionalProperties></m:FolderShape>' +
				'<m:FolderIds><t:FolderId Id="F1"/></m:FolderIds>'
		);
		const below = request.subfolderTotals('F1');
		expect(below).toContain('<m:FindFolder Traversal="Deep">');
		expect(below).toContain('<m:ParentFolderIds><t:FolderId Id="F1"/></m:ParentFolderIds>');
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

describe('meetings', () => {
	it('deletes calendar items in Drafts without notifying anyone', () => {
		expect(request.deleteItems(['A1'])).toContain('SendMeetingCancellations="SendToNone"');
	});

	it('escapes the calendar item and keeps the schema order', () => {
		const body = request.createMeeting({
			subject: 'Budget & plans',
			html: '<p>Hi</p>',
			start: '2026-10-20T08:00:00.000Z',
			end: '2026-10-20T08:30:00.000Z',
			location: null,
			required: [{ name: 'Alex <A>', address: 'alex@example.com' }],
			optional: []
		});
		expect(body).toContain('<t:Subject>Budget &amp; plans</t:Subject>');
		expect(body).toContain('<t:Body BodyType="HTML">&lt;p&gt;Hi&lt;/p&gt;</t:Body>');
		expect(body).toContain('<t:Name>Alex &lt;A&gt;</t:Name>');
		expect(body).not.toContain('Location');
		expect(body).not.toContain('OptionalAttendees');
		const order = ['Subject', 'Body', 'Start', 'End', 'RequiredAttendees'].map((name) =>
			body.indexOf(`<t:${name}`)
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('reads availability per address, unknown where Exchange has none', () => {
		const response = operationResponse(
			soap(
				'<m:GetUserAvailabilityResponse><m:FreeBusyResponseArray>' +
					'<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:ResponseMessage>' +
					'<m:FreeBusyView><t:FreeBusyViewType>FreeBusy</t:FreeBusyViewType><t:CalendarEventArray>' +
					'<t:CalendarEvent><t:StartTime>2026-10-20T08:00:00</t:StartTime><t:EndTime>2026-10-20T09:00:00</t:EndTime><t:BusyType>Busy</t:BusyType></t:CalendarEvent>' +
					'<t:CalendarEvent><t:StartTime>2026-10-20T10:00:00</t:StartTime><t:EndTime>2026-10-20T11:00:00</t:EndTime><t:BusyType>Free</t:BusyType></t:CalendarEvent>' +
					'<t:CalendarEvent><t:StartTime>2026-10-20T12:00:00</t:StartTime><t:EndTime>2026-10-20T13:00:00</t:EndTime><t:BusyType>Tentative</t:BusyType></t:CalendarEvent>' +
					'</t:CalendarEventArray></m:FreeBusyView></m:FreeBusyResponse>' +
					'<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorMailRecipientNotFound</m:ResponseCode></m:ResponseMessage></m:FreeBusyResponse>' +
					'</m:FreeBusyResponseArray></m:GetUserAvailabilityResponse>'
			)
		);
		expect(availabilityOf(response, ['me@example.org', 'guest@else.example'])).toEqual([
			{
				address: 'me@example.org',
				busy: [
					{ start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T09:00:00.000Z', tentative: false },
					{ start: '2026-10-20T12:00:00.000Z', end: '2026-10-20T13:00:00.000Z', tentative: true }
				]
			},
			{ address: 'guest@else.example', busy: null }
		]);
		const body = request.getUserAvailability(
			['a@b.example'],
			'2026-10-20T00:00:00Z',
			'2026-10-21T00:00:00Z'
		);
		expect(body).toContain('<t:StartTime>2026-10-20T00:00:00</t:StartTime>');
		// Exchange rejects a time zone whose two transitions are the same.
		const rule = (name: string) => body.match(new RegExp(`<t:${name}>(.*?)</t:${name}>`))?.[1];
		expect(rule('StandardTime')).toContain('<t:Bias>0</t:Bias>');
		expect(rule('DaylightTime')).toContain('<t:Bias>0</t:Bias>');
		expect(rule('StandardTime')).not.toBe(rule('DaylightTime'));
	});

	it('finds the meeting the user organizes by its UID', () => {
		const messages = responseMessages(
			soap(
				'<m:GetItemResponse><m:ResponseMessages>' +
					'<m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:CalendarItem>' +
					'<t:ItemId Id="OTHER" ChangeKey="K0"/><t:UID>abc</t:UID><t:IsOrganizer>false</t:IsOrganizer>' +
					'<t:CalendarItemType>Single</t:CalendarItemType></t:CalendarItem></m:Items></m:GetItemResponseMessage>' +
					'<m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:CalendarItem>' +
					'<t:ItemId Id="MINE" ChangeKey="K1"/><t:UID>ABC</t:UID><t:IsOrganizer>true</t:IsOrganizer>' +
					'<t:CalendarItemType>Single</t:CalendarItemType><t:RequiredAttendees>' +
					'<t:Attendee><t:Mailbox><t:Name>Alex</t:Name><t:EmailAddress>alex@example.com</t:EmailAddress></t:Mailbox></t:Attendee>' +
					'<t:Attendee><t:Mailbox><t:EmailAddress>kim@example.com</t:EmailAddress></t:Mailbox></t:Attendee>' +
					'</t:RequiredAttendees></t:CalendarItem></m:Items></m:GetItemResponseMessage>' +
					'</m:ResponseMessages></m:GetItemResponse>'
			)
		);
		expect(organizedMeetingOf(messages, 'abc')).toEqual({
			id: 'MINE',
			changeKey: 'K1',
			required: [
				{ name: 'Alex', address: 'alex@example.com' },
				{ name: '', address: 'kim@example.com' }
			],
			optional: []
		});
		expect(organizedMeetingOf(messages, 'other')).toBeNull();
	});

	it('updates only the changed fields and notifies the attendees', () => {
		const body = request.updateMeeting(
			{ id: 'A1', changeKey: 'K1' },
			{
				start: '2026-11-09T09:00:00.000Z',
				end: '2026-11-09T12:00:00.000Z',
				location: null,
				optional: [{ name: '', address: 'sam@example.com' }]
			}
		);
		expect(body).toContain('SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy"');
		expect(body).toContain('<t:ItemId Id="A1" ChangeKey="K1"/>');
		expect(body).toContain('<t:Start>2026-11-09T09:00:00.000Z</t:Start>');
		expect(body).toContain(
			'<t:DeleteItemField><t:FieldURI FieldURI="calendar:Location"/></t:DeleteItemField>'
		);
		expect(body).toContain('<t:OptionalAttendees><t:Attendee>');
		expect(body).not.toContain('item:Subject');
		expect(body).not.toContain('RequiredAttendees');
	});

	it('tells only the added and removed attendees when only the attendees change', () => {
		const body = request.updateMeeting(
			{ id: 'A1', changeKey: 'K1' },
			{ required: [{ name: '', address: 'lee@example.com' }], optional: [] }
		);
		expect(body).toContain('SendMeetingInvitationsOrCancellations="SendToChangedAndSaveCopy"');
		expect(body).toContain('<t:RequiredAttendees><t:Attendee>');
	});

	it('cancels with the item reference before the note', () => {
		const body = request.cancelMeeting({ id: 'A1', changeKey: 'K1' }, '<p>Sorry</p>');
		expect(body).toContain('MessageDisposition="SendAndSaveCopy"');
		expect(body.indexOf('<t:ReferenceItemId Id="A1" ChangeKey="K1"/>')).toBeLessThan(
			body.indexOf('<t:NewBodyContent BodyType="HTML">&lt;p&gt;Sorry&lt;/p&gt;</t:NewBodyContent>')
		);
		expect(request.calendarView('2026-11-02T09:00:00.000Z', '2026-11-02T12:00:00.000Z')).toContain(
			'<m:CalendarView MaxEntriesReturned="50" StartDate="2026-11-02T09:00:00.000Z"'
		);
	});
});
