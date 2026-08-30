const mongoose = require('mongoose');

const utils = require('../../utils');
const globalUtils = require('../../utils/global');
const namumarkUtils = require('../../utils/namumark/utils');

const CONFIG = {
    
    requiredPermission: 'config',
    pageSize: 50
};

const EditFilterLog = mongoose.models.EditFilterLog || mongoose.model('EditFilterLog', new mongoose.Schema({
    filterId: { type: String, required: true, index: true },
    namespace: { type: String, index: true },
    title: { type: String, index: true },
    uuid: { type: String, index: true },
    ver: Number,
    log: String,
    context: String,
    prevContent: String,
    matchedActions: [String],
    createdAt: { type: Date, default: Date.now, index: true }
}));

const esc = str => namumarkUtils.escapeHtml(String(str ?? ''));

module.exports = {
    name: 'edit-filter-log-page',
    type: 'page',
    url: '/admin/filter_log',
    handler: async (req, res) => {
        
        
        if(!req.permissions.includes(CONFIG.requiredPermission))
            return res.error(req.t('errors.missing_permission'), 403);

        const baseQuery = {};
        if(req.query.filterId) baseQuery.filterId = req.query.filterId.trim();
        if(req.query.namespace) baseQuery.namespace = req.query.namespace.trim();
        if(req.query.uuid) baseQuery.uuid = req.query.uuid.trim();

        const data = await utils.pagination(req, EditFilterLog, baseQuery, '_id', '_id', {
            limit: CONFIG.pageSize,
            getTotal: true
        });

        data.items = await utils.findUsers(req, data.items, 'uuid');
        
        
        
        for(const item of data.items) {
            item.createdAtLabel = item.createdAt
                ? new Date(item.createdAt).toISOString().replace('T', ' ').slice(0, 19)
                : '';
        }
        data.items = utils.withoutKeys(data.items, ['__v']);

        const searchParams = extra => {
            const params = new URLSearchParams({
                ...(req.query.filterId ? { filterId: req.query.filterId } : {}),
                ...(req.query.namespace ? { namespace: req.query.namespace } : {}),
                ...(req.query.uuid ? { uuid: req.query.uuid } : {}),
                ...extra
            });
            return `?${params.toString()}`;
        };

        const rows = (await Promise.all(data.items.map(async item => {
            const user = item.uuid;
            const editorLabel = user?.name ?? user?.uuid ?? '(알 수 없음)';
            const editorLink = user?.uuid ? globalUtils.contribution_link(user.uuid) : null;
            const docLink = globalUtils.doc_action_link({ namespace: item.namespace, title: item.title }, 'w');

            
            
            let diffHtml = '<p class="diff-empty">비교할 이전 내용이 없습니다.</p>';
            try {
                const diff = await utils.generateDiff(item.prevContent || '', item.context || '');
                diffHtml = `<table class="diff-table"><tbody>${diff.diffHtml}</tbody></table>`;
            } catch(e) {
                diffHtml = `<p class="diff-empty">diff 생성 실패: ${esc(e.message)}</p>`;
            }

            return `
            <tr>
                <td>${esc(item.createdAtLabel)}</td>
                <td>${esc(item.filterId)}</td>
                <td><a href="${esc(docLink)}">${esc(item.namespace)}:${esc(item.title)}</a></td>
                <td>${editorLink ? `<a href="${esc(editorLink)}">${esc(editorLabel)}</a>` : esc(editorLabel)}</td>
                <td>${esc(item.ver)}</td>
                <td>${esc(item.log)}</td>
                <td>${esc((item.matchedActions || []).join(', '))}</td>
            </tr>
            <tr>
                <td colspan="7" class="diff-cell">
                    <details>
                        <summary>변경 내용 보기</summary>
                        ${diffHtml}
                    </details>
                </td>
            </tr>`;
        }))).join('');

        const contentHtml = `
<div class="edit-filter-log">
    <style>
        .edit-filter-log table.log-table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 12px; }
        .edit-filter-log table.log-table th, .edit-filter-log table.log-table > tbody > tr > td { border: 1px solid var(--border-color, #ddd); padding: 6px 8px; text-align: left; vertical-align: top; }
        .edit-filter-log table.log-table th { background: var(--table-header-bg, #f5f5f5); }
        .edit-filter-log form.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
        .edit-filter-log form.filters input { padding: 4px 6px; }
        .edit-filter-log .meta { font-size: 12px; opacity: 0.7; margin-top: 4px; }
        .edit-filter-log .pagination { margin-top: 12px; display: flex; gap: 16px; }
        .edit-filter-log td.diff-cell { background: transparent; border: none; padding: 4px 8px 12px; }
        .edit-filter-log .diff-empty { font-size: 12px; opacity: 0.6; margin: 4px 0; }

       
        .edit-filter-log table.diff-table {
            border: 1px solid #a9a9a9;
            border-collapse: collapse;
            font-size: .9rem;
            white-space: pre-wrap;
            width: 100%;
        }
        .theseed-dark-mode .edit-filter-log table.diff-table { border-color: #383b40; }
        .edit-filter-log table.diff-table tbody th {
            background: #eed; border: 1px solid #bbc; color: #886;
            font-size: 11px; font-weight: 400; padding: .3em .5em .1em 2em;
            text-align: right; user-select: none; vertical-align: top; word-break: normal;
        }
        .theseed-dark-mode .edit-filter-log table.diff-table tbody th {
            background: #27292d; border: 1px solid #383b40; color: #8a8a8a;
        }
        .edit-filter-log table.diff-table tbody td { padding: .4em .4em 0; vertical-align: top; }
        .edit-filter-log table.diff-table tbody .skip { background-color: #efefef; border: 1px solid #aaa; border-right-color: #bbc; }
        .theseed-dark-mode .edit-filter-log table.diff-table tbody .skip { background-color: #2d2f34; border: 1px solid #383b40; }
        .edit-filter-log table.diff-table tbody div { word-wrap: break-word; word-break: break-all; }
        .edit-filter-log table.diff-table tbody .delete { background-color: #fdd; }
        .theseed-dark-mode .edit-filter-log table.diff-table tbody .delete { background-color: #943838; }
        .edit-filter-log table.diff-table tbody .insert { background-color: #cfc; }
        .theseed-dark-mode .edit-filter-log table.diff-table tbody .insert { background-color: #3b5a3b; }
        .edit-filter-log table.diff-table tbody del.diff { background-color: #fff; color: #999; text-decoration: line-through; }
        .theseed-dark-mode .edit-filter-log table.diff-table tbody del.diff { background-color: #d05d5d; color: #ddd; }
        .edit-filter-log table.diff-table tbody ins.diff { background-color: #50ff50; text-decoration: none; }
        .theseed-dark-mode .edit-filter-log table.diff-table tbody ins.diff { background-color: #1c751c; }
    </style>
    <p class="meta">총 ${data.total}건</p>
    <form class="filters" method="GET">
        <input type="text" name="filterId" placeholder="filterId" value="${esc(req.query.filterId || '')}">
        <input type="text" name="namespace" placeholder="namespace" value="${esc(req.query.namespace || '')}">
        <input type="text" name="uuid" placeholder="uuid" value="${esc(req.query.uuid || '')}">
        <button type="submit">검색</button>
    </form>
    <table class="log-table">
        <thead>
            <tr>
                <th>시각</th>
                <th>필터 ID</th>
                <th>문서</th>
                <th>편집자</th>
                <th>ver</th>
                <th>편집 요약</th>
                <th>매치된 액션</th>
            </tr>
        </thead>
        <tbody>
            ${rows || '<tr><td colspan="7">기록 없음</td></tr>'}
        </tbody>
    </table>
    <div class="pagination">
        ${data.pageProps.prev ? `<a href="${searchParams(data.pageProps.prev.query)}">← 이전</a>` : ''}
        ${data.pageProps.next ? `<a href="${searchParams(data.pageProps.next.query)}">다음 →</a>` : ''}
    </div>
</div>`;

        res.renderSkin('편집 필터 로그', {
            contentHtml
        });
    }
};